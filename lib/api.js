class ApiError extends Error {
    constructor(status, message, data = null) {
        super(message);
        this.status = status;
        this.data = data;
    }
}

function send(res, status, message, data) {
    return res.status(status).json({ message, data });
}

function asyncRoute(handler) {
    return function routeHandler(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    if (err instanceof ApiError) {
        return send(res, err.status, err.message, err.data);
    }

    if (err && err.code === 11000) {
        return send(res, 400, 'A user with that email already exists.', null);
    }

    if (err && (err.name === 'CastError' || err.name === 'ValidationError')) {
        return send(res, 400, 'The request contains an invalid value.', null);
    }

    if (err && err.status === 400 && err.type === 'entity.parse.failed') {
        return send(res, 400, 'The request body must contain valid JSON.', null);
    }

    console.error('Unexpected API error:', err);
    return send(res, 500, 'An unexpected server error occurred.', null);
}

module.exports = { ApiError, send, asyncRoute, errorHandler };
