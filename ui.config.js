const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
    entry: './ui/src/main.ts',
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/
            }
        ]
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './ui/index.html',
            filename: 'ui.html',
            inject: 'body'
        })
    ],
    resolve: {
        extensions: [ '.ts', '.js' ]
    },
    output: {
        filename: 'ui.js',
        path: __dirname + '/dist/'
    }
};
