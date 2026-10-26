module.exports = function (router) {

    var homeRoute = router.route('/');

    homeRoute.get(function (req, res) {
        res.json({ message: 'APIed Piper is running.', data: null });
    });

    return router;
}
