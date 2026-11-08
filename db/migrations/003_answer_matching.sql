-- =====================================================================
-- 003: "Same answer" matching + per-game standings + room settings.
--
--  * _answer_key(text): turns an answer into a comparison key so that
--    "Dogs", "dog", "the dog!" and "DOG" all match, as do "ice cream" /
--    "icecream" and "movie" / "movies".
--  * _answers_close(a, b): small typos ("basball" vs "baseball").
--  * Who Said It?: if two people wrote the same (or nearly the same)
--    answer, guessing either of them counts as right.
--  * Standings are now per game (each game has its own leaderboard).
--  * rooms.settings: host-chosen options, e.g. Blank Slate's target score.
-- =====================================================================

-- ---------- text matching helpers ------------------------------------

-- Edit distance with swapped letters counting as one edit ("freind").
create or replace function _lev(a text, b text) returns int
language plpgsql immutable as $$
declare
  la int := length(a); lb int := length(b);
  pp int[]; prev int[]; cur int[]; i int; j int; v int;
begin
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;
  if abs(la - lb) > 3 then return abs(la - lb); end if;
  prev := array(select generate_series(0, lb));
  for i in 1..la loop
    cur := array[i];
    for j in 1..lb loop
      v := least(prev[j + 1] + 1, cur[j] + 1,
                 prev[j] + case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end);
      if i > 1 and j > 1 and substr(a, i, 1) = substr(b, j - 1, 1) and substr(a, i - 1, 1) = substr(b, j, 1) then
        v := least(v, pp[j - 1] + 1);
      end if;
      cur := cur || v;
    end loop;
    pp := prev; prev := cur;
  end loop;
  return prev[lb + 1];
end $$;

-- One word -> a canonical singular-ish form. The result is only used for
-- comparing, never shown, so it's fine that it looks odd ("knife" -> "kniv").
create or replace function _word_key(w text) returns text
language plpgsql immutable as $$
declare irr jsonb := '{"mice":"mouse","feet":"foot","teeth":"tooth","geese":"goose","men":"man",
                       "women":"woman","children":"child","people":"person","oxen":"ox","dice":"die"}';
begin
  w := coalesce(w, '');
  if irr ? w then w := irr ->> w; end if;
  if length(w) > 3 then
    if w like '%ies' and length(w) > 4 then w := left(w, -3) || 'y';
    elsif w like '%ves' then w := left(w, -3) || 'v';
    elsif w like '%oes' then w := left(w, -2);
    elsif w ~ '(s|x|z|ch|sh)es$' then w := left(w, -2);
    elsif w like '%s' and w !~ '(ss|us)$' then w := left(w, -1);
    end if;
  end if;
  -- line up endings: movie/movies, shoe/shoes, knife/knives, leaf/leaves
  if length(w) > 2 and w like '%ie' then w := left(w, -2) || 'y'; end if;
  if length(w) > 2 and w like '%e' then w := left(w, -1); end if;
  if length(w) > 2 and w like '%f' then w := left(w, -1) || 'v'; end if;
  return w;
end $$;

-- Whole answer -> comparison key. p_drop is the card word in Blank Slate:
-- for "SNOW ___", typing "snowman" or "snow man" counts the same as "man".
create or replace function _answer_key(p_text text, p_drop text default null) returns text
language plpgsql immutable as $$
declare
  words text[]; d text; k text; n int;
begin
  words := array(
    select w from regexp_split_to_table(
      regexp_replace(replace(lower(coalesce(p_text, '')), '''', ''), '[^a-z0-9]+', ' ', 'g'), ' ') w
    where w <> '' and w not in ('a', 'an', 'the'));
  n := coalesce(array_length(words, 1), 0);
  if n = 0 then return ''; end if;

  d := _word_key(regexp_replace(lower(coalesce(p_drop, '')), '[^a-z0-9]+', '', 'g'));
  if d <> '' then
    if n > 1 and _word_key(words[1]) = d then
      words := words[2:n];
    elsif n > 1 and _word_key(words[n]) = d then
      words := words[1:n - 1];
    elsif n = 1 then
      k := _word_key(words[1]);
      if length(k) >= length(d) + 2 and left(k, length(d)) = d then
        words := array[substr(words[1], length(d) + 1)];
      elsif length(k) >= length(d) + 2 and right(k, length(d)) = d then
        words := array[left(k, length(k) - length(d))];
      end if;
    end if;
  end if;

  -- only the last word gets singularized: "hot dogs" = "hotdog", "ice cream" = "icecream"
  n := array_length(words, 1);
  return array_to_string(words[1:n - 1], '') || _word_key(words[n]);
end $$;

create or replace function _answers_same(a text, b text, p_drop text default null) returns boolean
language sql immutable as $$
  select _answer_key(a, p_drop) <> '' and _answer_key(a, p_drop) = _answer_key(b, p_drop);
$$;

-- Nearly the same: a small typo apart. Short words need an exact match
-- ("cat" vs "bat" are different answers). p_min is the shortest word length
-- where a one-letter typo is allowed.
create or replace function _answers_close(a text, b text, p_drop text default null, p_min int default 4) returns boolean
language plpgsql immutable as $$
declare ka text := _answer_key(a, p_drop); kb text := _answer_key(b, p_drop); m int; d int;
begin
  if ka = '' or kb = '' then return false; end if;
  if ka = kb then return true; end if;
  m := least(length(ka), length(kb));
  if m < p_min then return false; end if;
  d := _lev(ka, kb);
  return d <= 1 or (m >= 7 and d <= 2);
end $$;


-- ---------- room settings ---------------------------------------------

alter table rooms add column if not exists settings jsonb not null default '{}'::jsonb;

create or replace function api_room_setting(p_code text, p_token uuid, p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players;
begin
  me := _me(p_code, p_token);
  if not me.is_host then perform _err('HOST_ONLY'); end if;
  if p_key = 'target' then
    if jsonb_typeof(p_value) <> 'number' or (p_value::text)::int not between 5 and 100 then
      perform _err('BAD_SETTING');
    end if;
  else
    perform _err('BAD_SETTING');
  end if;
  update rooms set settings = settings || jsonb_build_object(p_key, p_value) where id = me.room_id;
  perform _touch(me.room_id);
  return jsonb_build_object('ok', true);
end $$;


-- ---------- per-game standings ----------------------------------------

create or replace function _standings(p_game text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.wins desc, x.points desc, x.name), '[]'::jsonb) from (
    select player_name as name, sum(points)::int as points, count(*)::int as rounds,
           (count(*) filter (where detail->>'won' = 'true'))::int as wins
      from scores where season_id = (select id from seasons where is_current) and game = p_game
     group by player_name
  ) x;
$$;

create or replace function api_state(p_code text, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players; r rooms; rd rounds; v_round jsonb := null; v_game jsonb;
begin
  me := _me(p_code, p_token);
  select * into r from rooms where id = me.room_id;
  rd := _current_round(r.id);
  if rd.id is not null then
    execute format('select public.%I($1, $2)', 'game_' || rd.game || '_view') into v_game using rd.id, me.id;
    v_round := jsonb_build_object(
      'id', rd.id, 'number', rd.number, 'phase', rd.phase, 'step', rd.step,
      'participants', to_jsonb(rd.participants), 'finished', rd.finished,
      'question', rd.question,
      'submitted', coalesce((select jsonb_object_agg(kind, ids) from (
          select kind, jsonb_agg(player_id) ids from submissions
           where round_id = rd.id and player_id = any(rd.participants) group by kind) s), '{}'::jsonb),
      'game', v_game);
  end if;
  return jsonb_build_object(
    'version', r.version,
    'room', jsonb_build_object('code', r.code, 'game', r.game,
              'game_name', (select name from games where id = r.game),
              'min_players', (select min_players from games where id = r.game),
              'settings', r.settings),
    'me', jsonb_build_object('id', me.id, 'name', me.name, 'is_host', me.is_host),
    'players', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'is_host', is_host, 'seat', seat) order by seat), '[]')
                  from players where room_id = r.id and not removed),
    'season', (select jsonb_build_object('id', id, 'name', name, 'started_at', started_at) from seasons where is_current),
    'standings', _standings(r.game),
    'round', v_round);
end $$;

create or replace function api_past_seasons(p_code text, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players; v_game text;
begin
  me := _me(p_code, p_token);
  select game into v_game from rooms where id = me.room_id;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'name', s.name, 'started_at', s.started_at, 'ended_at', s.ended_at,
            'standings', (select coalesce(jsonb_agg(x order by x.wins desc, x.points desc), '[]') from (
                select player_name as name, sum(points)::int as points,
                       (count(*) filter (where detail->>'won' = 'true'))::int as wins
                  from scores where season_id = s.id and game = v_game group by player_name) x)
          ) order by s.id desc), '[]') from seasons s where not s.is_current);
end $$;


-- ---------- Who Said It?: same answers are interchangeable -------------

-- Did players a and b write the same (or nearly the same) answer this round?
create or replace function game_who_said_it_same(p_round uuid, a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select _answers_close(sa.payload->>'text', sb.payload->>'text', null, 6)
      from submissions sa, submissions sb
     where sa.round_id = p_round and sa.kind = 'answer' and sa.player_id = a
       and sb.round_id = p_round and sb.kind = 'answer' and sb.player_id = b), false);
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
        -- +1 for each answer matched to its author, or to someone who wrote the same thing
        (select count(*) from submissions g
           cross join lateral jsonb_each_text(g.payload->'map') m
           join game_who_said_it_items(rd.id) it on it.key = m.key
          where g.round_id = rd.id and g.kind = 'guesses' and g.player_id = p.id
            and it.pid <> p.id
            and (m.value::uuid = it.pid or game_who_said_it_same(rd.id, m.value::uuid, it.pid)))::int as correct,
        -- +1 for each player who got this player's answer wrong
        (select count(*) from submissions g
           cross join lateral jsonb_each_text(g.payload->'map') m
           join game_who_said_it_items(rd.id) it on it.key = m.key
          where g.round_id = rd.id and g.kind = 'guesses' and g.player_id <> p.id
            and g.player_id = any(rd.participants)
            and it.pid = p.id and m.value::uuid <> p.id
            and not game_who_said_it_same(rd.id, m.value::uuid, p.id))::int as fooled
    ) x
   where p.id = any(rd.participants);

  update rounds set phase = 'results', finished = true where id = rd.id;
end $$;

-- Same as before, plus "twins": others who wrote the same answer (shown once
-- the author is revealed, so guessing either name shows as right).
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
          'twins', case when it.idx < v_idx or v_sub = 1 then
              (select coalesce(jsonb_agg(o.pid), '[]') from game_who_said_it_items(rd.id) o
                where o.pid <> it.pid and _answers_close(o.text, it.text, null, 6)) end,
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
