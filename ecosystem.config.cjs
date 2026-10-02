module.exports = {
  apps: [
    {
      name: "waflow",
      script: "src/index.js",
      instances: 1,
      exec_mode: "fork",
    },
  ],
};
