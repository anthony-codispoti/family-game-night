// GAME REGISTRY — to add a game:
//   1. create src/games/<name>/index.js (see who-said-it for the shape)
//   2. add its SQL module in db/migrations + api/_lib/db.js MIGRATIONS (game_<id>_start/_action/_view/_check)
//   3. import it below with a short unique prefix for its button actions
import whoSaidIt from './who-said-it/index.js';

export const GAMES = [
  { ...whoSaidIt, prefix: 'wsi' },
];

export const gameById = (id) => GAMES.find((g) => g.id === id) || GAMES[0];
