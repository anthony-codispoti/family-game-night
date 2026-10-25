-- Family Game Night: full database setup.
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run.

-- =====================================================================
-- FAMILY PARTY GAME ENGINE
-- Rooms, players, rounds, private submissions, scoring, seasons, questions.
--
-- Security model:
--   * Every table has Row Level Security ON with NO policies, and the
--     public (anon) role has no table privileges. Nobody can read or write
--     tables directly from the browser.
--   * The browser can only call the "api_*" functions below. Each one
--     checks the room code + the player's secret device token, and only
--     returns what that player is allowed to see (e.g. never other
--     people's answers before the reveal).
--   * Each game is a plug-in: SQL functions named game_<id>_start,
--     game_<id>_action, game_<id>_view, game_<id>_check.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- tables ----------------------------------------------------

create table if not exists seasons (
  id          bigserial primary key,
  name        text not null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  is_current  boolean not null default true
);
create unique index if not exists seasons_one_current on seasons (is_current) where is_current;

create table if not exists roster (
  name text primary key,
  sort int not null default 100
);

create table if not exists games (
  id          text primary key,           -- e.g. 'who_said_it'
  name        text not null,
  min_players int  not null default 2
);

create table if not exists rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  game        text not null references games(id),
  status      text not null default 'open' check (status in ('open','closed')),
  version     bigint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists rooms_code_open on rooms (code) where status = 'open';

create table if not exists players (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references rooms(id) on delete cascade,
  name        text not null,
  token       uuid not null default gen_random_uuid(),
  is_host     boolean not null default false,
  removed     boolean not null default false,
  seat        int not null default 0,
  joined_at   timestamptz not null default now()
);
create unique index if not exists players_room_name on players (room_id, lower(name)) where not removed;
create index if not exists players_token on players (token);

create table if not exists rounds (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references rooms(id) on delete cascade,
  number        int not null,
  game          text not null references games(id),
  phase         text not null default 'starting',
  participants  uuid[] not null default '{}',
  question_id   bigint,
  question      text,
  step          int not null default 0,
  data          jsonb not null default '{}'::jsonb,   -- PRIVATE game data, never sent raw
  finished      boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists rounds_room on rounds (room_id, number desc);

create table if not exists submissions (
  round_id    uuid not null references rounds(id) on delete cascade,
  player_id   uuid not null references players(id) on delete cascade,
  kind        text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (round_id, player_id, kind)
);

create table if not exists scores (
  id          bigserial primary key,
  season_id   bigint not null references seasons(id),
  room_id     uuid references rooms(id) on delete set null,
  round_id    uuid references rounds(id) on delete set null,
  game        text not null,
  player_name text not null,
  points      int not null default 0,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists scores_season on scores (season_id);

create table if not exists questions (
  id          bigserial primary key,
  game        text not null references games(id),
  category    text not null,
  text        text not null,
  source      text not null default 'bank' check (source in ('bank','family')),
  author      text,
  active      boolean not null default true,
  used        boolean not null default false,
  times_used  int not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists questions_game_text on questions (game, lower(text));

-- ---------- lock everything down -------------------------------------

alter table seasons     enable row level security;
alter table roster      enable row level security;
alter table games       enable row level security;
alter table rooms       enable row level security;
alter table players     enable row level security;
alter table rounds      enable row level security;
alter table submissions enable row level security;
alter table scores      enable row level security;
alter table questions   enable row level security;

revoke all on seasons, roster, games, rooms, players, rounds, submissions, scores, questions
  from anon, authenticated;

-- ---------- seed data -------------------------------------------------

insert into seasons (name) select 'Season 1' where not exists (select 1 from seasons);
insert into roster (name, sort) values ('Dad',1),('Mom',2),('Gio',3),('Valentino',4)
  on conflict (name) do nothing;

-- ---------- internal helpers (not callable from the browser) ---------

create or replace function _err(msg text) returns void language plpgsql as $$
begin
  raise exception using message = msg, errcode = 'P0001';
end $$;

-- Bump room version and ping every device in the room (Realtime broadcast).
create or replace function _touch(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_code text; v_ver bigint;
begin
  update rooms set version = version + 1, updated_at = now()
   where id = p_room returning code, version into v_code, v_ver;
  begin
    perform realtime.send(jsonb_build_object('v', v_ver), 'changed', 'room-' || v_code, false);
  exception when others then
    null; -- realtime not available: devices fall back to polling
  end;
end $$;

-- Find the caller's player row from room code + secret token.
create or replace function _me(p_code text, p_token uuid) returns players
language plpgsql security definer set search_path = public as $$
declare r rooms; p players;
begin
  select * into r from rooms where code = upper(trim(p_code)) and status = 'open';
  if not found then perform _err('ROOM_NOT_FOUND'); end if;
  select * into p from players where room_id = r.id and token = p_token;
  if not found then perform _err('NOT_IN_ROOM'); end if;
  if p.removed then perform _err('REMOVED'); end if;
  return p;
end $$;

create or replace function _current_round(p_room uuid) returns rounds
language sql stable security definer set search_path = public as $$
  select * from rounds where room_id = p_room order by number desc limit 1;
$$;

create or replace function _clean_name(p text) returns text language sql immutable as $$
  select left(regexp_replace(trim(coalesce(p,'')), '\s+', ' ', 'g'), 20);
$$;

create or replace function _random_code() returns text language plpgsql as $$
declare
  alphabet text := 'BCDFGHJKLMNPQRSTVWXZ';  -- no vowels = no accidental words
  c text;
begin
  loop
    c := '';
    for i in 1..4 loop
      c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from rooms where code = c and status = 'open');
  end loop;
  return c;
end $$;

-- Pick the next question for a game. Bank and family questions each cycle
-- separately: nothing repeats until its pool is used up. Family-written
-- questions get ~40% of picks, so they come up more often.
create or replace function _pick_question(p_game text, p_exclude bigint default null) returns questions
language plpgsql security definer set search_path = public as $$
declare q questions; v_src text;
begin
  if exists (select 1 from questions where game = p_game and active and source = 'family')
     and random() < 0.4 then
    v_src := 'family';
  else
    v_src := 'bank';
  end if;
  if not exists (select 1 from questions where game = p_game and active and source = v_src) then
    v_src := case when v_src = 'bank' then 'family' else 'bank' end;
  end if;

  if not exists (select 1 from questions where game = p_game and active and source = v_src
                  and not used and id is distinct from p_exclude) then
    update questions set used = false where game = p_game and source = v_src;  -- start a new cycle
  end if;

  select * into q from questions
   where game = p_game and active and source = v_src and not used and id is distinct from p_exclude
   order by random() limit 1;
  if not found then
    select * into q from questions where game = p_game and active order by random() limit 1;
  end if;
  if not found then perform _err('NO_QUESTIONS'); end if;

  update questions set used = true, times_used = times_used + 1 where id = q.id;
  return q;
end $$;

-- Sync the question bank from the app's JSON file: {category: [text, ...]}.
create or replace function _sync_bank(p_game text, p_bank jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  if p_bank is null or jsonb_typeof(p_bank) <> 'object' then return; end if;
  create temp table _incoming on commit drop as
    select distinct on (lower(left(trim(t.value),200))) c.key as category, left(trim(t.value), 200) as text
      from jsonb_each(p_bank) c, jsonb_array_elements_text(c.value) t
     where jsonb_typeof(c.value) = 'array' and length(trim(t.value)) between 3 and 200;
  select count(*) into v_count from _incoming;
  if v_count < 20 then drop table _incoming; return; end if;

  insert into questions (game, category, text, source)
    select p_game, category, text, 'bank' from _incoming
  on conflict (game, lower(text)) do update
    set category = excluded.category, active = true
    where questions.source = 'bank';

  update questions q set active = false
   where q.game = p_game and q.source = 'bank' and q.active
     and not exists (select 1 from _incoming i where lower(i.text) = lower(q.text));
  drop table _incoming;
end $$;

create or replace function _standings() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.points desc, x.name), '[]'::jsonb) from (
    select player_name as name, sum(points)::int as points, count(*)::int as rounds
      from scores where season_id = (select id from seasons where is_current)
     group by player_name
  ) x;
$$;

-- ---------- public API (the only things the browser can call) --------

create or replace function api_roster() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(name order by sort, name), '[]'::jsonb) from roster;
$$;

create or replace function api_create_room(p_name text, p_game text, p_bank jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r rooms; p players; v_name text := _clean_name(p_name);
begin
  if v_name = '' then perform _err('NAME_REQUIRED'); end if;
  if not exists (select 1 from games where id = p_game) then perform _err('UNKNOWN_GAME'); end if;
  -- close rooms nobody has touched in 12 hours, so codes get recycled
  update rooms set status = 'closed' where status = 'open' and updated_at < now() - interval '12 hours';
  perform _sync_bank(p_game, p_bank);
  insert into rooms (code, game) values (_random_code(), p_game) returning * into r;
  insert into players (room_id, name, is_host, seat) values (r.id, v_name, true, 0) returning * into p;
  return jsonb_build_object('code', r.code, 'token', p.token, 'player_id', p.id);
end $$;

create or replace function api_join_room(p_code text, p_name text, p_reclaim boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r rooms; p players; v_name text := _clean_name(p_name);
begin
  if v_name = '' then perform _err('NAME_REQUIRED'); end if;
  select * into r from rooms where code = upper(trim(p_code)) and status = 'open';
  if not found then perform _err('ROOM_NOT_FOUND'); end if;
  select * into p from players where room_id = r.id and lower(name) = lower(v_name) and not removed;
  if found then
    if not p_reclaim then perform _err('NAME_TAKEN'); end if;
    -- same person on a new device: hand over the seat with a fresh token
    update players set token = gen_random_uuid() where id = p.id returning * into p;
  else
    if (select count(*) from players where room_id = r.id and not removed) >= 12 then
      perform _err('ROOM_FULL');
    end if;
    insert into players (room_id, name, seat)
      values (r.id, v_name, (select coalesce(max(seat),0)+1 from players where room_id = r.id))
      returning * into p;
  end if;
  perform _touch(r.id);
  return jsonb_build_object('code', r.code, 'token', p.token, 'player_id', p.id);
end $$;

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
              'min_players', (select min_players from games where id = r.game)),
    'me', jsonb_build_object('id', me.id, 'name', me.name, 'is_host', me.is_host),
    'players', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'is_host', is_host, 'seat', seat) order by seat), '[]')
                  from players where room_id = r.id and not removed),
    'season', (select jsonb_build_object('id', id, 'name', name, 'started_at', started_at) from seasons where is_current),
    'standings', _standings(),
    'round', v_round);
end $$;

-- Cheap check used by polling: has anything changed?
create or replace function api_version(p_code text) returns bigint
language sql stable security definer set search_path = public as $$
  select version from rooms where code = upper(trim(p_code)) and status = 'open';
$$;

create or replace function api_start_round(p_code text, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players; r rooms; rd rounds; v_ids uuid[]; v_min int; v_new uuid;
begin
  me := _me(p_code, p_token);
  if not me.is_host then perform _err('HOST_ONLY'); end if;
  select * into r from rooms where id = me.room_id for update;
  rd := _current_round(r.id);
  if rd.id is not null and not rd.finished then perform _err('ROUND_IN_PROGRESS'); end if;
  select array_agg(id order by seat) into v_ids from players where room_id = r.id and not removed;
  select min_players into v_min from games where id = r.game;
  if coalesce(array_length(v_ids,1),0) < v_min then perform _err('NOT_ENOUGH_PLAYERS'); end if;
  insert into rounds (room_id, number, game, participants)
    values (r.id, coalesce(rd.number,0) + 1, r.game, v_ids) returning id into v_new;
  execute format('select public.%I($1)', 'game_' || r.game || '_start') using v_new;
  perform _touch(r.id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function api_action(p_code text, p_token uuid, p_action text, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me players; rd rounds; v_res jsonb;
begin
  me := _me(p_code, p_token);
  perform 1 from rooms where id = me.room_id for update;   -- one action at a time per room
  rd := _current_round(me.room_id);
  if rd.id is null then perform _err('NO_ROUND'); end if;
  execute format('select public.%I($1, $2, $3, $4, $5)', 'game_' || rd.game || '_action')
    into v_res using rd.id, me.id, me.is_host, p_action, coalesce(p_args, '{}'::jsonb);
  perform _touch(me.room_id);
  return coalesce(v_res, jsonb_build_object('ok', true));
end $$;

create or replace function api_cancel_round(p_code text, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players; rd rounds;
begin
  me := _me(p_code, p_token);
  if not me.is_host then perform _err('HOST_ONLY'); end if;
  rd := _current_round(me.room_id);
  if rd.id is not null and not rd.finished then
    -- give the question back so it isn't wasted
    update questions set used = false where id = rd.question_id;
    delete from rounds where id = rd.id;
  end if;
  perform _touch(me.room_id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function api_remove_player(p_code text, p_token uuid, p_player uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players; rd rounds;
begin
  me := _me(p_code, p_token);
  if not me.is_host then perform _err('HOST_ONLY'); end if;
  if p_player = me.id then perform _err('CANNOT_REMOVE_SELF'); end if;
  perform 1 from rooms where id = me.room_id for update;
  update players set removed = true where id = p_player and room_id = me.room_id;
  rd := _current_round(me.room_id);
  if rd.id is not null and not rd.finished then
    update rounds set participants = array_remove(participants, p_player) where id = rd.id;
    execute format('select public.%I($1)', 'game_' || rd.game || '_check') using rd.id;
  end if;
  perform _touch(me.room_id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function api_leave_room(p_code text, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players; rd rounds; v_next uuid;
begin
  me := _me(p_code, p_token);
  perform 1 from rooms where id = me.room_id for update;
  update players set removed = true where id = me.id;
  if me.is_host then
    select id into v_next from players where room_id = me.room_id and not removed order by seat limit 1;
    if v_next is null then
      update rooms set status = 'closed' where id = me.room_id;
    else
      update players set is_host = false where id = me.id;
      update players set is_host = true where id = v_next;
    end if;
  end if;
  rd := _current_round(me.room_id);
  if rd.id is not null and not rd.finished then
    update rounds set participants = array_remove(participants, me.id) where id = rd.id;
    execute format('select public.%I($1)', 'game_' || rd.game || '_check') using rd.id;
  end if;
  perform _touch(me.room_id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function api_make_host(p_code text, p_token uuid, p_player uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players;
begin
  me := _me(p_code, p_token);
  if not me.is_host then perform _err('HOST_ONLY'); end if;
  if not exists (select 1 from players where id = p_player and room_id = me.room_id and not removed) then
    perform _err('NOT_IN_ROOM');
  end if;
  update players set is_host = (id = p_player) where room_id = me.room_id;
  perform _touch(me.room_id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function api_new_season(p_code text, p_token uuid, p_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players; v_n int;
begin
  me := _me(p_code, p_token);
  if not me.is_host then perform _err('HOST_ONLY'); end if;
  select count(*) + 1 into v_n from seasons;
  update seasons set is_current = false, ended_at = now() where is_current;
  insert into seasons (name) values (coalesce(nullif(left(trim(p_name), 40), ''), 'Season ' || v_n));
  perform _touch(me.room_id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function api_past_seasons(p_code text, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players;
begin
  me := _me(p_code, p_token);
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'name', s.name, 'started_at', s.started_at, 'ended_at', s.ended_at,
            'standings', (select coalesce(jsonb_agg(x order by x.points desc), '[]') from (
                select player_name as name, sum(points)::int as points from scores
                 where season_id = s.id group by player_name) x)
          ) order by s.id desc), '[]') from seasons s where not s.is_current);
end $$;

create or replace function api_add_question(p_code text, p_token uuid, p_category text, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players; r rooms; v_text text := left(regexp_replace(trim(coalesce(p_text,'')), '\s+', ' ', 'g'), 150);
begin
  me := _me(p_code, p_token);
  select * into r from rooms where id = me.room_id;
  if length(v_text) < 5 then perform _err('QUESTION_TOO_SHORT'); end if;
  if exists (select 1 from questions where game = r.game and lower(text) = lower(v_text)) then
    perform _err('QUESTION_EXISTS');
  end if;
  insert into questions (game, category, text, source, author)
    values (r.game, coalesce(nullif(left(trim(p_category), 30), ''), 'family'), v_text, 'family', me.name);
  return jsonb_build_object('ok', true);
end $$;

create or replace function api_family_questions(p_code text, p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players; r rooms;
begin
  me := _me(p_code, p_token);
  select * into r from rooms where id = me.room_id;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'text', text, 'author', author,
            'category', category, 'times_used', times_used) order by created_at desc), '[]')
            from questions where game = r.game and source = 'family' and active);
end $$;

create or replace function api_delete_question(p_code text, p_token uuid, p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me players;
begin
  me := _me(p_code, p_token);
  -- the host, or whoever wrote it, can delete a family question
  update questions set active = false
   where id = p_id and source = 'family' and (me.is_host or lower(author) = lower(me.name));
  return jsonb_build_object('ok', true);
end $$;

-- ---------- permissions on functions ---------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  api_roster(), api_create_room(text,text,jsonb), api_join_room(text,text,boolean),
  api_state(text,uuid), api_version(text), api_start_round(text,uuid),
  api_action(text,uuid,text,jsonb), api_cancel_round(text,uuid),
  api_remove_player(text,uuid,uuid), api_leave_room(text,uuid), api_make_host(text,uuid,uuid),
  api_new_season(text,uuid,text), api_past_seasons(text,uuid),
  api_add_question(text,uuid,text,text), api_family_questions(text,uuid),
  api_delete_question(text,uuid,bigint)
to anon, authenticated;

-- New functions (e.g. future games) are NOT callable by the browser unless granted explicitly.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
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

revoke execute on function game_who_said_it_start(uuid), game_who_said_it_check(uuid),
  game_who_said_it_items(uuid), game_who_said_it_score(uuid),
  game_who_said_it_action(uuid,uuid,boolean,text,jsonb), game_who_said_it_view(uuid,uuid)
  from public, anon, authenticated;
