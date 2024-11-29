import dotenv from 'dotenv';
dotenv.config();

const config = {
    environment: process.env.NODE_ENV || 'development',

    server: {
        port: process.env.PORT || 3000,
    },

    database: {
        uri: process.env.MONGO_URI || 'mongodb://localhost:27017/blackhansa',
        options: {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        },
    },
    priority: {
        candidate: 0,
        expert: 0,
        admin: 1,
        superAdmin: 2,
    },
    auth: {
        tokenSecret: process.env.ACCESS_TOKEN_SECRET || 'thisbetterbeasecret',
        tokenExpiration: '15m',
        //wont be using the following for now
        //access token
        // accessTokenSecret: process.env.ACCESS_TOKEN_SECRET || 'thisbetterbeasecret',
        // accessTokenExpiration: '15m',
        // refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET || 'thishastobeastrongsecret', //wont be using this for now
        // refreshTokenExpiration: '7d',
        // //for email verification
        // emailTokenSecret: process.env.EMAIL_TOKEN_SECRET || 'doesthisneedtobesecret',
        // emailTokenExpiration: '1d',
        // //for password reset
        // resetTokenSecret: process.env.RESET_TOKEN_SECRET || 'thisisasecretmaybe',
        // resetTokenExpiration: '1h',
    },
    //later include more config options for production
};

export default config;