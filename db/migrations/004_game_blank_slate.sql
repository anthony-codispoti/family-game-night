-- =====================================================================
-- GAME MODULE: Blank Slate
-- A card shows a word with a blank ("SNOW ___"). Everyone secretly writes
-- one word. Match exactly one other person: +3 each. Match 2+ others: +1
-- each. Nobody matches you: 0. First to the target score (default 25) wins;
-- a tie at the top means one more card.
--
-- Phases: answering -> reveal -> results
--   reveal: answers are grouped automatically (same word, ignoring case,
--   plurals, spaces). The host reveals the groups one at a time, then can
--   join or split groups (typos, "same thing" calls) before scoring.
--
-- Private round data (rounds.data):
--   match, target   which game-to-25 this card belongs to, and its target
--   word            the card word, e.g. "snow" (typing "snowman" = "man")
--   groups          {player_id: group_id}
--   revealed        true once every group has been shown
--   dismissed       ["pidA|pidB"]  "not the same" calls on typo suggestions
--   winner / tie    set when the card is scored
-- =====================================================================

insert into games (id, name, min_players) values ('blank_slate', 'Blank Slate', 3)
  on conflict (id) do update set name = excluded.name, min_players = excluded.min_players;

create or replace function game_blank_slate_new_card(p_round uuid, p_exclude bigint default null) returns void
language plpgsql security definer set search_path = public as $$
declare q questions;
begin
  q := _pick_question('blank_slate', p_exclude);
  update rounds set question_id = q.id, question = q.text,
         data = data || jsonb_build_object('word', trim(replace(lower(q.text), '___', '')))
   where id = p_round;
end $$;

create or replace function game_blank_slate_start(p_round uuid) returns void
language plpgsql security definer set search_path = public as $$
declare rd rounds; prev rounds; v_match int; v_target int;
begin
  select * into rd from rounds where id = p_round;
  select * into prev from rounds
   where room_id = rd.room_id and game = 'blank_slate' and number < rd.number
   order by number desc limit 1;
  if prev.id is not null and prev.data->>'winner' is null then
    v_match := (prev.data->>'match')::int;            -- keep playing the same game
    v_target := (prev.data->>'target')::int;
  else
    v_match := coalesce((prev.data->>'match')::int, 0) + 1;   -- new game
    select coalesce((settings->>'target')::int, 25) into v_target from rooms where id = rd.room_id;
  end if;
  update rounds set phase = 'answering', step = 0,
         data = jsonb_build_object('match', v_match, 'target', v_target)
   where id = p_round;
  perform game_blank_slate_new_card(p_round);
end $$;

-- Group answers that are the same word.
create or replace function game_blank_slate_group(p_round uuid) returns void
language plpgsql security definer set search_path = public as $$
declare rd rounds; v_groups jsonb;
begin
  select * into rd from rounds where id = p_round;
  with a as (
    select player_id, _answer_key(payload->>'text', rd.data->>'word') k
      from submissions where round_id = rd.id and kind = 'answer' and player_id = any(rd.participants)
  ), g as (
    select k, substr(md5(random()::text || k), 1, 8) gid from (select distinct k from a) d
  )
  select jsonb_object_agg(a.player_id,
           case when a.k = '' then substr(md5(random()::text || a.player_id), 1, 8) else g.gid end)
    into v_groups
    from a join g using (k);
  update rounds set data = data || jsonb_build_object('groups', coalesce(v_groups, '{}'::jsonb), 'revealed', false)
   where id = rd.id;
end $$;

-- Groups still in play, in reveal order: lonely answers first, then crowds
-- (+1), then pairs (+3) last for the big finish.
create or replace function game_blank_slate_groups(p_round uuid)
returns table (idx int, gid text, size int, points int, members jsonb)
language sql stable security definer set search_path = public as $$
  with m as (
    select g.value as gid, g.key::uuid as pid, s.payload->>'text' as text, p.seat
      from rounds rd
      cross join lateral jsonb_each_text(rd.data->'groups') g
      join submissions s on s.round_id = rd.id and s.player_id = g.key::uuid and s.kind = 'answer'
      join players p on p.id = g.key::uuid
     where rd.id = p_round and g.key::uuid = any(rd.participants)
  ), grp as (
    select gid, count(*)::int as size,
           jsonb_agg(jsonb_build_object('pid', pid, 'text', text) order by seat) as members
      from m group by gid
  )
  select (row_number() over (order by case when size = 1 then 0 when size >= 3 then 1 else 2 end, gid) - 1)::int,
         gid, size, case when size = 2 then 3 when size >= 3 then 1 else 0 end, members
    from grp;
$$;

create or replace function game_blank_slate_check(p_round uuid) returns void
language plpgsql security definer set search_path = public as $$
declare rd rounds; v_need int; v_have int;
begin
  select * into rd from rounds where id = p_round;
  v_need := coalesce(array_length(rd.participants, 1), 0);
  if rd.phase = 'answering' then
    select count(*) into v_have from submissions
     where round_id = rd.id and kind = 'answer' and player_id = any(rd.participants);
    if v_need > 0 and v_have >= v_need then
      perform game_blank_slate_group(rd.id);
      update rounds set phase = 'reveal', step = 0 where id = rd.id;
    end if;
  elsif rd.phase = 'reveal' and not coalesce((rd.data->>'revealed')::boolean, false) then
    -- someone left mid-reveal: maybe everything is already showing
    if rd.step >= (select count(*) from game_blank_slate_groups(rd.id)) then
      update rounds set data = data || '{"revealed": true}' where id = rd.id;
    end if;
  end if;
end $$;

-- Points per player in a game-to-25, for players still in the room.
create or replace function game_blank_slate_totals(p_room uuid, p_match int)
returns table (name text, points int)
language sql stable security definer set search_path = public as $$
  select p.name, coalesce(sum(s.points), 0)::int
    from players p
    left join (scores s join rounds r on r.id = s.round_id
                and r.game = 'blank_slate' and r.room_id = p_room and (r.data->>'match')::int = p_match)
      on lower(s.player_name) = lower(p.name)
   where p.room_id = p_room and not p.removed
   group by p.name;
$$;

create or replace function game_blank_slate_score(p_round uuid) returns void
language plpgsql security definer set search_path = public as $$
declare rd rounds; v_season bigint; v_top int; v_leaders text[];
begin
  select * into rd from rounds where id = p_round for update;
  if rd.finished or rd.phase <> 'reveal' then return; end if;
  select id into v_season from seasons where is_current;

  insert into scores (season_id, room_id, round_id, game, player_name, points, detail)
  select v_season, rd.room_id, rd.id, 'blank_slate', p.name, g.points,
         jsonb_build_object('matched', g.size - 1, 'answer', mem->>'text')
    from game_blank_slate_groups(rd.id) g
    cross join lateral jsonb_array_elements(g.members) mem
    join players p on p.id = (mem->>'pid')::uuid;

  select max(points) into v_top from game_blank_slate_totals(rd.room_id, (rd.data->>'match')::int);
  if v_top >= (rd.data->>'target')::int then
    select array_agg(name) into v_leaders
      from game_blank_slate_totals(rd.room_id, (rd.data->>'match')::int) where points = v_top;
    if array_length(v_leaders, 1) = 1 then
      update scores set detail = detail || '{"won": true}'
       where round_id = rd.id and lower(player_name) = lower(v_leaders[1]);
      update rounds set data = data || jsonb_build_object('winner', v_leaders[1]) where id = rd.id;
    else
      update rounds set data = data || '{"tie": true}' where id = rd.id;
    end if;
  end if;

  update rounds set phase = 'results', finished = true where id = rd.id;
end $$;

create or replace function game_blank_slate_action(p_round uuid, p_player uuid, p_is_host boolean, p_action text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rd rounds; v_text text; v_total int; v_groups jsonb; v_a uuid; v_b uuid; v_ga text; v_gb text;
begin
  select * into rd from rounds where id = p_round for update;
  v_groups := coalesce(rd.data->'groups', '{}'::jsonb);

  if p_action = 'skip' then
    if not p_is_host then perform _err('HOST_ONLY'); end if;
    if rd.phase <> 'answering' then perform _err('TOO_LATE_TO_SKIP'); end if;
    delete from submissions where round_id = rd.id;
    perform game_blank_slate_new_card(rd.id, rd.question_id);

  elsif p_action = 'answer' then
    if rd.phase <> 'answering' then perform _err('WRONG_PHASE'); end if;
    if not p_player = any(rd.participants) then perform _err('NOT_IN_ROUND'); end if;
    v_text := left(regexp_replace(trim(coalesce(p_args->>'text', '')), '\s+', ' ', 'g'), 30);
    if v_text = '' then perform _err('ANSWER_REQUIRED'); end if;
    insert into submissions (round_id, player_id, kind, payload)
      values (rd.id, p_player, 'answer', jsonb_build_object('text', v_text))
      on conflict (round_id, player_id, kind) do update set payload = excluded.payload, created_at = now();
    perform game_blank_slate_check(rd.id);

  elsif p_action = 'next' then
    if not p_is_host then perform _err('HOST_ONLY'); end if;
    if rd.phase <> 'reveal' then perform _err('WRONG_PHASE'); end if;
    if coalesce((rd.data->>'revealed')::boolean, false) then
      perform game_blank_slate_score(rd.id);
    else
      select count(*) into v_total from game_blank_slate_groups(rd.id);
      update rounds set step = step + 1,
             data = data || jsonb_build_object('revealed', step + 1 >= v_total)
       where id = rd.id;
    end if;

  elsif p_action in ('move', 'split', 'merge', 'dismiss') then
    -- the host's "these are the same / not the same" calls, after the full reveal
    if not p_is_host then perform _err('HOST_ONLY'); end if;
    if rd.phase <> 'reveal' or not coalesce((rd.data->>'revealed')::boolean, false) then
      perform _err('WRONG_PHASE');
    end if;
    v_a := (p_args->>'a')::uuid;
    v_b := nullif(p_args->>'b', '')::uuid;
    if not (v_groups ? v_a::text) or not v_a = any(rd.participants) then perform _err('UNKNOWN_PLAYER'); end if;
    if p_action <> 'split' and (v_b is null or not (v_groups ? v_b::text) or not v_b = any(rd.participants) or v_a = v_b) then
      perform _err('UNKNOWN_PLAYER');
    end if;
    v_ga := v_groups->>v_a::text;
    v_gb := v_groups->>v_b::text;
    if p_action = 'move' then
      -- move one player's answer into another group
      v_groups := v_groups || jsonb_build_object(v_a::text, v_gb);
    elsif p_action = 'split' then
      -- give one player's answer its own group
      v_groups := v_groups || jsonb_build_object(v_a::text, substr(md5(random()::text || v_a), 1, 8));
    elsif p_action = 'merge' then
      -- join two whole groups
      select jsonb_object_agg(key, case when value = v_ga then v_gb else value end)
        into v_groups from jsonb_each_text(v_groups);
    else
      update rounds set data = jsonb_set(data, '{dismissed}',
               coalesce(data->'dismissed', '[]'::jsonb) || to_jsonb(least(v_a::text, v_b::text) || '|' || greatest(v_a::text, v_b::text)))
       where id = rd.id;
      return jsonb_build_object('ok', true);
    end if;
    update rounds set data = data || jsonb_build_object('groups', v_groups) where id = rd.id;

  else
    perform _err('UNKNOWN_ACTION');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- What one player is allowed to see right now.
create or replace function game_blank_slate_view(p_round uuid, p_player uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rd rounds; v jsonb; v_revealed boolean; v_show int;
begin
  select * into rd from rounds where id = p_round;
  v_revealed := coalesce((rd.data->>'revealed')::boolean, false) or rd.phase = 'results';
  v := jsonb_build_object(
    'match', (rd.data->>'match')::int,
    'target', (rd.data->>'target')::int,
    'my_answer', (select payload->>'text' from submissions where round_id = rd.id and player_id = p_player and kind = 'answer'),
    'revealed', v_revealed,
    'winner', rd.data->>'winner',
    'tie', coalesce((rd.data->>'tie')::boolean, false),
    'card_no', (select count(*) from rounds r where r.room_id = rd.room_id and r.game = 'blank_slate'
                  and (r.data->>'match')::int = (rd.data->>'match')::int and r.number <= rd.number),
    'totals', (select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'points', t.points)), '[]')
                 from game_blank_slate_totals(rd.room_id, (rd.data->>'match')::int) t),
    'gained', case when rd.phase = 'results' then
                (select coalesce(jsonb_object_agg(player_name, points), '{}') from scores where round_id = rd.id) end);

  if rd.phase in ('reveal', 'results') then
    v_show := case when v_revealed then 1000 else rd.step end;
    v := v || jsonb_build_object(
      'total_groups', (select count(*) from game_blank_slate_groups(rd.id)),
      'groups', (select coalesce(jsonb_agg(jsonb_build_object(
                    'gid', g.gid, 'size', g.size, 'points', g.points, 'members', g.members) order by g.idx), '[]')
                   from game_blank_slate_groups(rd.id) g where g.idx < v_show));
  end if;

  if rd.phase = 'reveal' and v_revealed then
    -- possible typos across different groups, for the host to confirm
    v := v || jsonb_build_object('suggestions', (
      select coalesce(jsonb_agg(x), '[]') from (
        select distinct on (ga.gid, gb.gid)
               jsonb_build_object('a', ma->>'pid', 'b', mb->>'pid', 'ta', ma->>'text', 'tb', mb->>'text') x
          from game_blank_slate_groups(rd.id) ga
          join game_blank_slate_groups(rd.id) gb on ga.gid < gb.gid
          cross join lateral jsonb_array_elements(ga.members) ma
          cross join lateral jsonb_array_elements(gb.members) mb
         where _answers_close(ma->>'text', mb->>'text', rd.data->>'word')
           and not coalesce(rd.data->'dismissed', '[]'::jsonb) ?
                 (least(ma->>'pid', mb->>'pid') || '|' || greatest(ma->>'pid', mb->>'pid'))
         limit 6) s));
  end if;
  return v;
end $$;
