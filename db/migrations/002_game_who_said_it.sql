-- =====================================================================
-- GAME MODULE: Who Said It?
-- Phases: answering -> matching -> reveal -> results -> standings
-- Private round data (rounds.data):
--   answers: [{key, pid}]   shuffled; key is a random id so nobody can
--                           tell who wrote an answer from the key
-- =====================================================================

insert into games (id, name, min_players) values ('who_said_it', 'Who Said It?', 3)
  on conflict (id) do update set name = excluded.name, min_players = excluded.min_players;

create or replace function game_who_said_it_start(p_round uuid) returns void
language plpgsql security definer set search_path = public as $$
declare q questions;
begin
  q := _pick_question('who_said_it');
  update rounds set phase = 'answering', question_id = q.id, question = q.text, step = 0,
         data = jsonb_build_object('category', q.category, 'q_author', q.author)
   where id = p_round;
end $$;

-- Move the round forward when everyone still in it has submitted.
create or replace function game_who_said_it_check(p_round uuid) returns void
language plpgsql security definer set search_path = public as $$
declare rd rounds; v_need int; v_have int; v_answers jsonb;
begin
  select * into rd from rounds where id = p_round;
  v_need := coalesce(array_length(rd.participants, 1), 0);

  if rd.phase = 'answering' then
    select count(*) into v_have from submissions
     where round_id = rd.id and kind = 'answer' and player_id = any(rd.participants);
    if v_need > 0 and v_have >= v_need then
      select jsonb_agg(jsonb_build_object('key', substr(md5(random()::text), 1, 10), 'pid', player_id) order by random())
        into v_answers
        from submissions where round_id = rd.id and kind = 'answer' and player_id = any(rd.participants);
      update rounds set phase = 'matching', data = data || jsonb_build_object('answers', v_answers)
       where id = rd.id;
    end if;

  elsif rd.phase = 'matching' then
    select count(*) into v_have from submissions
     where round_id = rd.id and kind = 'guesses' and player_id = any(rd.participants);
    if v_need > 0 and v_have >= v_need then
      update rounds set phase = 'reveal', step = 0 where id = rd.id;
    end if;

  elsif rd.phase = 'reveal' then
    -- someone left during the reveal: clamp the step
    if rd.step >= 2 * (select count(*) from jsonb_array_elements(rd.data->'answers') a
                        where (a->>'pid')::uuid = any(rd.participants)) then
      perform game_who_said_it_score(p_round);
    end if;
  end if;
end $$;

-- Answers still in play (authors who haven't left), in reveal order.
create or replace function game_who_said_it_items(p_round uuid)
returns table (idx int, key text, pid uuid, text text)
language sql stable security definer set search_path = public as $$
  select (row_number() over (order by a.ord) - 1)::int, a.v->>'key', (a.v->>'pid')::uuid, s.payload->>'text'
    from rounds rd
    cross join lateral jsonb_array_elements(rd.data->'answers') with ordinality a(v, ord)
    join submissions s on s.round_id = rd.id and s.player_id = (a.v->>'pid')::uuid and s.kind = 'answer'
   where rd.id = p_round and (a.v->>'pid')::uuid = any(rd.participants);
$$;

create or replace function game_who_said_it_score(p_round uuid) returns void
language plpgsql security definer set search_path = public as $$
declare rd rounds; v_season bigint;
begin
  select * into rd from rounds where id = p_round for update;
  if rd.finished or rd.phase in ('results','standings') then return; end if;
  select id into v_season from seasons where is_current;

  insert into scores (season_id, room_id, round_id, game, player_name, points, detail)
  select v_season, rd.room_id, rd.id, 'who_said_it', p.name, x.correct + x.fooled,
         jsonb_build_object('correct', x.correct, 'fooled', x.fooled)
    from players p
    cross join lateral (
      select
        -- +1 for each answer this player matched to the right author
        (select count(*) from submissions g
           cross join lateral jsonb_each_text(g.payload->'map') m
           join game_who_said_it_items(rd.id) it on it.key = m.key
          where g.round_id = rd.id and g.kind = 'guesses' and g.player_id = p.id
            and it.pid <> p.id and m.value::uuid = it.pid)::int as correct,
        -- +1 for each player who matched this player's answer to someone else
        (select count(*) from submissions g
           cross join lateral jsonb_each_text(g.payload->'map') m
           join game_who_said_it_items(rd.id) it on it.key = m.key
          where g.round_id = rd.id and g.kind = 'guesses' and g.player_id <> p.id
            and g.player_id = any(rd.participants)
            and it.pid = p.id and m.value::uuid <> p.id)::int as fooled
    ) x
   where p.id = any(rd.participants);

  update rounds set phase = 'results', finished = true where id = rd.id;
end $$;

create or replace function game_who_said_it_action(p_round uuid, p_player uuid, p_is_host boolean, p_action text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rd rounds; q questions; v_text text; v_map jsonb; v_keys text[]; v_vals text[]; v_total int;
begin
  select * into rd from rounds where id = p_round for update;

  if p_action = 'skip' then
    if not p_is_host then perform _err('HOST_ONLY'); end if;
    if rd.phase <> 'answering' then perform _err('TOO_LATE_TO_SKIP'); end if;
    q := _pick_question('who_said_it', rd.question_id);
    delete from submissions where round_id = rd.id;
    update rounds set question_id = q.id, question = q.text,
           data = jsonb_build_object('category', q.category, 'q_author', q.author)
     where id = rd.id;

  elsif p_action = 'answer' then
    if rd.phase <> 'answering' then perform _err('WRONG_PHASE'); end if;
    if not p_player = any(rd.participants) then perform _err('NOT_IN_ROUND'); end if;
    v_text := left(regexp_replace(trim(coalesce(p_args->>'text', '')), '\s+', ' ', 'g'), 100);
    if v_text = '' then perform _err('ANSWER_REQUIRED'); end if;
    insert into submissions (round_id, player_id, kind, payload)
      values (rd.id, p_player, 'answer', jsonb_build_object('text', v_text))
      on conflict (round_id, player_id, kind) do update set payload = excluded.payload, created_at = now();
    perform game_who_said_it_check(rd.id);

  elsif p_action = 'guesses' then
    if rd.phase <> 'matching' then perform _err('WRONG_PHASE'); end if;
    if not p_player = any(rd.participants) then perform _err('NOT_IN_ROUND'); end if;
    v_map := p_args->'map';
    if v_map is null or jsonb_typeof(v_map) <> 'object' then perform _err('BAD_GUESSES'); end if;
    -- keep only keys for answers that aren't mine
    select coalesce(jsonb_object_agg(m.key, m.value), '{}'::jsonb), array_agg(m.key), array_agg(m.value)
      into v_map, v_keys, v_vals
      from jsonb_each_text(v_map) m
      join game_who_said_it_items(rd.id) it on it.key = m.key and it.pid <> p_player;
    select count(*) into v_total from game_who_said_it_items(rd.id) where pid <> p_player;
    if coalesce(array_length(v_keys, 1), 0) <> v_total then perform _err('ASSIGN_ALL'); end if;
    if (select count(distinct v) from unnest(v_vals) v) <> v_total then perform _err('NAME_USED_TWICE'); end if;
    if exists (select 1 from unnest(v_vals) v where v = p_player::text) then perform _err('NOT_YOURSELF'); end if;
    if exists (select 1 from unnest(v_vals) v where not v::uuid = any(rd.participants)) then perform _err('UNKNOWN_PLAYER'); end if;
    insert into submissions (round_id, player_id, kind, payload)
      values (rd.id, p_player, 'guesses', jsonb_build_object('map', v_map))
      on conflict (round_id, player_id, kind) do update set payload = excluded.payload, created_at = now();
    perform game_who_said_it_check(rd.id);

  elsif p_action = 'next' then
    if not p_is_host then perform _err('HOST_ONLY'); end if;
    if rd.phase = 'reveal' then
      select count(*) into v_total from game_who_said_it_items(rd.id);
      if rd.step + 1 >= 2 * v_total then
        perform game_who_said_it_score(rd.id);
      else
        update rounds set step = step + 1 where id = rd.id;
      end if;
    elsif rd.phase = 'results' then
      update rounds set phase = 'standings' where id = rd.id;
    else
      perform _err('WRONG_PHASE');
    end if;

  else
    perform _err('UNKNOWN_ACTION');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- What one player is allowed to see right now.
create or replace function game_who_said_it_view(p_round uuid, p_player uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rd rounds; v jsonb; v_idx int; v_sub int; v_total int; v_in boolean;
begin
  select * into rd from rounds where id = p_round;
  v_in := p_player = any(rd.participants);
  v := jsonb_build_object(
    'category', rd.data->>'category',
    'q_author', rd.data->>'q_author',
    'my_answer', (select payload->>'text' from submissions where round_id = rd.id and player_id = p_player and kind = 'answer'),
    'my_guesses', (select payload->'map' from submissions where round_id = rd.id and player_id = p_player and kind = 'guesses'));

  if rd.phase = 'matching' and v_in then
    -- everyone else's answers, no authors
    v := v || jsonb_build_object('answers',
      (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'text', text) order by idx), '[]')
         from game_who_said_it_items(rd.id) where pid <> p_player));
  end if;

  if rd.phase in ('reveal','results','standings') then
    select count(*) into v_total from game_who_said_it_items(rd.id);
    if rd.phase = 'reveal' then
      v_idx := rd.step / 2; v_sub := rd.step % 2;
    else
      v_idx := v_total - 1; v_sub := 1;
    end if;
    v := v || jsonb_build_object('total', v_total, 'index', v_idx, 'author_shown', v_sub = 1,
      'items', (select coalesce(jsonb_agg(jsonb_build_object(
          'idx', it.idx, 'text', it.text,
          'author', case when it.idx < v_idx or v_sub = 1 then it.pid end,
          'guesses', case when it.idx < v_idx or v_sub = 1 then
              (select coalesce(jsonb_object_agg(g.player_id, g.payload->'map'->>it.key), '{}')
                 from submissions g where g.round_id = rd.id and g.kind = 'guesses'
                  and g.player_id = any(rd.participants) and g.player_id <> it.pid) end
        ) order by it.idx), '[]')
        from game_who_said_it_items(rd.id) it where it.idx <= v_idx));
  end if;

  if rd.phase in ('results','standings') then
    v := v || jsonb_build_object('results',
      (select coalesce(jsonb_agg(jsonb_build_object('name', player_name, 'points', points,
                'correct', (detail->>'correct')::int, 'fooled', (detail->>'fooled')::int)
              order by points desc, player_name), '[]')
         from scores where round_id = rd.id));
  end if;
  return v;
end $$;

