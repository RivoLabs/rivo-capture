module.exports = {
    entry: './src/client/client.ts',
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/
            }
        ]
    },
    resolve: {
        extensions: [ '.tsx', '.ts', '.js' ],
        fallback: {
            fs: false
        }
    },
    output: {
        filename: 'client.js',
        path: __dirname + '/dist/'
    },
    node: false
};
