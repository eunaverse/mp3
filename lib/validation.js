const mongoose = require('mongoose');
const { ApiError } = require('./api');

function requireBodyObject(body) {
    if (body === null || Array.isArray(body) || typeof body !== 'object') {
        throw new ApiError(400, 'The request body must be a JSON object.', null);
    }
}

function requireNonemptyString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ApiError(400, `${field} is required and must be a nonempty string.`, null);
    }
    return value;
}

function optionalString(value, field, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string') {
        throw new ApiError(400, `${field} must be a string.`, null);
    }
    return value;
}

function validateObjectId(value, field) {
    if (typeof value !== 'string' || !mongoose.isObjectIdOrHexString(value)) {
        throw new ApiError(400, `${field} must contain a valid id.`, null);
    }
    return value;
}

function validateUserBody(body) {
    requireBodyObject(body);
    const name = requireNonemptyString(body.name, 'name');
    const email = requireNonemptyString(body.email, 'email');
    const pendingTasks = body.pendingTasks === undefined ? [] : body.pendingTasks;

    if (!Array.isArray(pendingTasks)) {
        throw new ApiError(400, 'pendingTasks must be an array of task ids.', null);
    }
    pendingTasks.forEach((id) => validateObjectId(id, 'pendingTasks'));
    if (new Set(pendingTasks).size !== pendingTasks.length) {
        throw new ApiError(400, 'pendingTasks cannot contain duplicate task ids.', null);
    }
    return { name, email, pendingTasks };
}

function validateTaskBody(body) {
    requireBodyObject(body);
    const name = requireNonemptyString(body.name, 'name');
    const description = optionalString(body.description, 'description', '');

    if (typeof body.deadline !== 'string' && !(body.deadline instanceof Date)) {
        throw new ApiError(400, 'deadline is required and must be a valid date.', null);
    }
    const deadline = new Date(body.deadline);
    if (Number.isNaN(deadline.getTime())) {
        throw new ApiError(400, 'deadline is required and must be a valid date.', null);
    }

    const completed = body.completed === undefined ? false : body.completed;
    if (typeof completed !== 'boolean') {
        throw new ApiError(400, 'completed must be a boolean.', null);
    }

    const assignedUser = body.assignedUser === undefined ? '' : body.assignedUser;
    if (typeof assignedUser !== 'string') {
        throw new ApiError(400, 'assignedUser must be a string.', null);
    }
    if (assignedUser !== '') validateObjectId(assignedUser, 'assignedUser');

    const defaultName = assignedUser === '' ? 'unassigned' : undefined;
    const assignedUserName = optionalString(body.assignedUserName, 'assignedUserName', defaultName);
    if (assignedUser === '' && assignedUserName !== 'unassigned') {
        throw new ApiError(400, 'An unassigned task must use assignedUserName "unassigned".', null);
    }

    return { name, description, deadline, completed, assignedUser, assignedUserName };
}

module.exports = { validateUserBody, validateTaskBody };
