const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env');
    }
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      realtime: {
        transport: ws,
      },
    });
  }
  return _client;
}

module.exports = new Proxy({}, {
  get(_, prop) {
    return getClient()[prop];
  },
});
