// PM2 process file for the VPS. Start with:  pm2 start ecosystem.config.cjs && pm2 save
// Settings (port, address, secrets) live in .env.production next to this file — see .env.production.example.
module.exports = {
  apps: [
    {
      name: "brill-tables",
      cwd: __dirname,
      script: "apps/api/dist/server.mjs",
      node_args: "--env-file=.env.production --enable-source-maps",
      // One process only: the built-in database and live updates live in this process.
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      kill_timeout: 8000,
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
