-- =====================================================================
-- FAMILY PARTY GAME ENGINE
-- Rooms, players, rounds, private submissions, scoring, seasons, questions.
--
-- Security model:
--   * The browser never talks to the database. It calls /api/rpc on
--     Vercel, which may only run the "api_*" functions below (allow-list).
--   * Each api_* function checks the room code + the player's secret
--     device token, and only returns what that player is allowed to see
--     (e.g. never other people's answers before the reveal).
--   * Row Level Security is also ON for every table with no policies, so
--     any database role other than the owner sees nothing.
--   * Each game is a plug-in: SQL functions named game_<id>_start,
--     game_<id>_action, game_<id>_view, game_<id>_check.
-- =====================================================================


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
  last_pick   bigint,                     -- value of question_picks when last asked
  created_at  timestamptz not null default now()
);
create sequence if not exists question_picks;
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


-- ---------- seed data -------------------------------------------------

insert into seasons (name) select 'Season 1' where not exists (select 1 from seasons);
insert into roster (name, sort) values ('Dad',1),('Mom',2),('Gio',3),('Valentino',4)
  on conflict (name) do nothing;

-- ---------- internal helpers (not callable from the browser) ---------

create or replace function _err(msg text) returns void language plpgsql as $$
begin
  raise exception using message = msg, errcode = 'P0001';
end $$;

-- Bump the room's version number; devices watching the room notice and refresh.
create or replace function _touch(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update rooms set version = version + 1, updated_at = now() where id = p_room;
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

-- Pick the next question for a game.
--   * Bank questions: nothing repeats until the whole bank has been used.
--   * Family-written questions jump the line (~40% of picks while one is
--     available), but a family question can't come back until at least
--     20 other questions have been asked since it was last used.
create or replace function _pick_question(p_game text, p_exclude bigint default null) returns questions
language plpgsql security definer set search_path = public as $$
declare q questions; v_seq bigint := nextval('question_picks');
begin
  if random() < 0.4 then
    if not exists (select 1 from questions where game = p_game and active and source = 'family'
                    and not used and id is distinct from p_exclude) then
      update questions set used = false
       where game = p_game and source = 'family' and used and coalesce(last_pick, 0) < v_seq - 20;
    end if;
    select * into q from questions
     where game = p_game and active and source = 'family' and not used and id is distinct from p_exclude
     order by random() limit 1;
  end if;

  if q.id is null then
    if not exists (select 1 from questions where game = p_game and active and source = 'bank'
                    and not used and id is distinct from p_exclude) then
      update questions set used = false where game = p_game and source = 'bank';  -- new cycle
    end if;
    select * into q from questions
     where game = p_game and active and source = 'bank' and not used and id is distinct from p_exclude
     order by random() limit 1;
  end if;

  if q.id is null then
    select * into q from questions where game = p_game and active and id is distinct from p_exclude
     order by coalesce(last_pick, 0) limit 1;
  end if;
  if q.id is null then perform _err('NO_QUESTIONS'); end if;

  update questions set used = true, times_used = times_used + 1, last_pick = v_seq where id = q.id;
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

