const createExpoWebpackConfigAsync = require('@expo/webpack-config');

module.exports = async function (env, argv) {
    const config = await createExpoWebpackConfigAsync(env, argv);

    // Fix crypto module not found (expo-modules-core uses it)
    config.resolve = {
        ...config.resolve,
        fallback: {
            ...config.resolve?.fallback,
            crypto: false,
        },
    };

    // Proxy API and WebSocket requests to the backend
    config.devServer = {
        ...config.devServer,
        port: 8081,
        allowedHosts: 'all',
        host: '0.0.0.0',
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
                secure: false,
            },
            '/ws': {
                target: 'ws://localhost:3000',
                ws: true,
                changeOrigin: true,
                secure: false,
            },
            '/uploads': {
                target: 'http://localhost:3000',
                changeOrigin: true,
                secure: false,
            },
        },
    };

    return config;
};
