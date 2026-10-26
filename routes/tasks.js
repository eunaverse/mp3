const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError, asyncRoute, send } = require('../lib/api');
const { inTransaction } = require('../lib/database');
const { parseCollectionQuery, parseSelect } = require('../lib/query');
const { validateTaskBody } = require('../lib/validation');

function validUrlId(id) {
    return mongoose.isObjectIdOrHexString(id);
}

async function resolveAssignee(input, session) {
    if (input.assignedUser === '') return null;
    const user = await User.findById(input.assignedUser).session(session);
    if (!user) throw new ApiError(404, 'Assigned user not found.', null);

    if (input.assignedUserName !== undefined && input.assignedUserName !== user.name) {
        throw new ApiError(400, 'assignedUserName does not match the assigned user.', null);
    }
    input.assignedUserName = user.name;
    return user;
}

async function synchronizeTaskReference(taskId, oldUserId, input, session) {
    const id = taskId.toString();
    if (oldUserId) {
        await User.updateOne(
            { _id: oldUserId },
            { $pull: { pendingTasks: id } },
            { session }
        );
    }
    if (input.assignedUser && !input.completed) {
        await User.updateOne(
            { _id: input.assignedUser },
            { $addToSet: { pendingTasks: id } },
            { session }
        );
    }
}

module.exports = function tasksRoutes(router) {
    router.get('/tasks', asyncRoute(async (req, res) => {
        const options = parseCollectionQuery(req.query, 100);
        if (options.count) {
            const count = await Task.countDocuments(options.where);
            return send(res, 200, 'Tasks counted successfully.', count);
        }
        if (options.limit === 0) {
            return send(res, 200, 'Tasks retrieved successfully.', []);
        }

        let query = Task.find(options.where).skip(options.skip).limit(options.limit);
        if (options.sort) query = query.sort(options.sort);
        if (options.select) query = query.select(options.select);
        return send(res, 200, 'Tasks retrieved successfully.', await query.exec());
    }));

    router.post('/tasks', asyncRoute(async (req, res) => {
        const input = validateTaskBody(req.body);
        const created = await inTransaction(async (session) => {
            await resolveAssignee(input, session);
            const task = new Task(input);
            await task.save({ session });
            await synchronizeTaskReference(task._id, '', input, session);
            return task.toObject();
        });
        return send(res, 201, 'Task created successfully.', created);
    }));

    router.get('/tasks/:id', asyncRoute(async (req, res) => {
        if (!validUrlId(req.params.id)) {
            throw new ApiError(404, 'Task not found.', null);
        }
        const select = parseSelect(req.query.select);
        let query = Task.findById(req.params.id);
        if (select) query = query.select(select);
        const task = await query.exec();
        if (!task) throw new ApiError(404, 'Task not found.', null);
        return send(res, 200, 'Task retrieved successfully.', task);
    }));

    router.put('/tasks/:id', asyncRoute(async (req, res) => {
        if (!validUrlId(req.params.id)) {
            throw new ApiError(404, 'Task not found.', null);
        }

        const updated = await inTransaction(async (session) => {
            const task = await Task.findById(req.params.id).session(session);
            if (!task) throw new ApiError(404, 'Task not found.', null);

            const input = validateTaskBody(req.body);
            await resolveAssignee(input, session);
            const oldUserId = task.assignedUser;
            task.name = input.name;
            task.description = input.description;
            task.deadline = input.deadline;
            task.completed = input.completed;
            task.assignedUser = input.assignedUser;
            task.assignedUserName = input.assignedUserName;
            await task.save({ session });
            await synchronizeTaskReference(task._id, oldUserId, input, session);
            return task.toObject();
        });
        return send(res, 200, 'Task updated successfully.', updated);
    }));

    router.delete('/tasks/:id', asyncRoute(async (req, res) => {
        if (!validUrlId(req.params.id)) {
            throw new ApiError(404, 'Task not found.', null);
        }
        await inTransaction(async (session) => {
            const task = await Task.findById(req.params.id).session(session);
            if (!task) throw new ApiError(404, 'Task not found.', null);
            if (task.assignedUser) {
                await User.updateOne(
                    { _id: task.assignedUser },
                    { $pull: { pendingTasks: task._id.toString() } },
                    { session }
                );
            }
            await Task.deleteOne({ _id: task._id }, { session });
        });
        return res.status(204).end();
    }));

    return router;
};
