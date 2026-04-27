module.exports = {
  apps: [
    {
      name: 'polymarket-copy-trade',
      cwd: __dirname,
      script: './dist/index.js',
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
