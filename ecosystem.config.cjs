/**
 * PM2 process definition.
 *
 * Single instance on purpose: a Discord gateway connection cannot be clustered
 * — running two processes with the same token would duplicate every event and
 * make the bot speak everything twice. Scale by sharding, not by cluster mode.
 */
module.exports = {
  apps: [
    {
      name: 'nim-tts-bot',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',

      env_production: {
        NODE_ENV: 'production',
      },

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      // Voice buffers make the RSS spiky; leave headroom above steady state.
      max_memory_restart: '1G',

      // Logging — pino already emits JSON in production, so do not re-timestamp.
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      merge_logs: true,
      time: false,

      // Give in-flight audio a chance to finish before SIGKILL.
      kill_timeout: 5000,
      wait_ready: false,
    },
  ],
};
