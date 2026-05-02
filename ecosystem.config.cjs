module.exports = {
  apps: [
    {
      name: 'polymarket-copy-trade',
      cwd: __dirname,
      script: './dist/index.js',
      out_file: `${__dirname}/logs/pm2/out.log`,
      error_file: `${__dirname}/logs/pm2/error.log`,
      log_file: `${__dirname}/logs/pm2/combined.log`,
      interpreter: '/usr/local/bin/node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      time: true,
      env: {
        NODE_ENV: 'production',
        PATH: `/usr/local/bin:${process.env.PATH || ''}`,
      },
    },
  ],
};
