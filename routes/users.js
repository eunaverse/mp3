const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError, asyncRoute, send } = require('../lib/api');
const { inTransaction } = require('../lib/database');
const { parseCollectionQuery, parseSelect } = require('../lib/query');
const { validateUserBody } = require('../lib/validation');

function validUrlId(id) {
    return mongoose.isObjectIdOrHexString(id);
}

async function findReferencedTasks(ids, session) {
    if (ids.length === 0) return [];
    const tasks = await Task.find({ _id: { $in: ids } }).session(session);
    if (tasks.length !== ids.length) {
        throw new ApiError(404, 'One or more referenced tasks were not found.', null);
    }
    if (tasks.some((task) => task.completed)) {
        throw new ApiError(400, 'Completed tasks cannot appear in pendingTasks.', null);
    }
    return tasks;
}

async function ensureEmailAvailable(email, excludedId, session) {
    const query = { email };
    if (excludedId) query._id = { $ne: excludedId };
    if (await User.exists(query).session(session)) {
        throw new ApiError(400, 'A user with that email already exists.', null);
    }
}

async function moveTasksToUser(tasks, user, session) {
    const taskIds = tasks.map((task) => task._id.toString());
    if (taskIds.length === 0) return;

    await User.updateMany(
        { _id: { $ne: user._id }, pendingTasks: { $in: taskIds } },
        { $pull: { pendingTasks: { $in: taskIds } } },
        { session }
    );
    await Task.updateMany(
        { _id: { $in: taskIds } },
        { $set: { assignedUser: user._id.toString(), assignedUserName: user.name } },
        { session }
    );
}

module.exports = function usersRoutes(router) {
    router.get('/users', asyncRoute(async (req, res) => {
        const options = parseCollectionQuery(req.query, undefined);
        if (options.count) {
            const count = await User.countDocuments(options.where);
            return send(res, 200, 'Users counted successfully.', count);
        }
        if (options.limit === 0) {
            return send(res, 200, 'Users retrieved successfully.', []);
        }

        let query = User.find(options.where).skip(options.skip);
        if (options.sort) query = query.sort(options.sort);
        if (options.select) query = query.select(options.select);
        if (options.limit !== undefined) query = query.limit(options.limit);
        return send(res, 200, 'Users retrieved successfully.', await query.exec());
    }));

    router.post('/users', asyncRoute(async (req, res) => {
        const input = validateUserBody(req.body);
        const created = await inTransaction(async (session) => {
            await ensureEmailAvailable(input.email, null, session);
            const tasks = await findReferencedTasks(input.pendingTasks, session);
            const user = new User(input);
            await user.save({ session });
            await moveTasksToUser(tasks, user, session);
            return user.toObject();
        });
        return send(res, 201, 'User created successfully.', created);
    }));

    router.get('/users/:id', asyncRoute(async (req, res) => {
        if (!validUrlId(req.params.id)) {
            throw new ApiError(404, 'User not found.', null);
        }
        const select = parseSelect(req.query.select);
        let query = User.findById(req.params.id);
        if (select) query = query.select(select);
        const user = await query.exec();
        if (!user) throw new ApiError(404, 'User not found.', null);
        return send(res, 200, 'User retrieved successfully.', user);
    }));

    router.put('/users/:id', asyncRoute(async (req, res) => {
        if (!validUrlId(req.params.id)) {
            throw new ApiError(404, 'User not found.', null);
        }

        const updated = await inTransaction(async (session) => {
            const user = await User.findById(req.params.id).session(session);
            if (!user) throw new ApiError(404, 'User not found.', null);

            const input = validateUserBody(req.body);
            await ensureEmailAvailable(input.email, user._id, session);
            const tasks = await findReferencedTasks(input.pendingTasks, session);

            const oldIds = user.pendingTasks;
            const newIdSet = new Set(input.pendingTasks);
            const removedIds = oldIds.filter((id) => !newIdSet.has(id));
            if (removedIds.length > 0) {
                await Task.updateMany(
                    { _id: { $in: removedIds }, assignedUser: user._id.toString() },
                    { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
                    { session }
                );
            }

            user.name = input.name;
            user.email = input.email;
            user.pendingTasks = input.pendingTasks;
            await moveTasksToUser(tasks, user, session);
            await Task.updateMany(
                { assignedUser: user._id.toString() },
                { $set: { assignedUserName: user.name } },
                { session }
            );
            await user.save({ session });
            return user.toObject();
        });
        return send(res, 200, 'User updated successfully.', updated);
    }));

    router.delete('/users/:id', asyncRoute(async (req, res) => {
        if (!validUrlId(req.params.id)) {
            throw new ApiError(404, 'User not found.', null);
        }
        await inTransaction(async (session) => {
            const user = await User.findById(req.params.id).session(session);
            if (!user) throw new ApiError(404, 'User not found.', null);
            await Task.updateMany(
                { assignedUser: user._id.toString() },
                { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
                { session }
            );
            await User.deleteOne({ _id: user._id }, { session });
        });
        return res.status(204).end();
    }));

    return router;
};
