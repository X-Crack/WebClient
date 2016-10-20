angular.module('proton.conversation')
.directive('conversation', (
    $filter,
    $rootScope,
    $state,
    $stateParams,
    $timeout,
    actionConversation,
    conversationListeners,
    messageActions,
    authentication,
    messageScroll,
    cache,
    CONSTANTS,
    tools,
    hotkeys
) => {

    /**
     * Find in the conversation the last message:scrollable
     * @param  {Array}  list List of message
     * @return {Object}
     */
    const getScrollableMessage = (list = []) => {
        const config = _.chain(list)
            .map((message, index) => ({ message, index }))
            .filter(({ message }) => !message.isDraft())
            .last()
            .value();

        if (!config) {
            return {
                index: list[list.length - 1],
                message: _.last(list)
            };
        }

        return config;
    };

    /**
     * Scroll to a message
     * If we can scroll we can reset the cache (expendable)
     * @param  {Object} expendables Config scrollable message
     * @param  {Object} data        Config current message
     * @return {Object}
     */
    function scrollToItem(expendable, data) {

        if (!messageScroll.hasPromise()) {
            // Only scroll for the current message
            if (expendable.message.ID === data.message.ID) {
                messageScroll.to(expendable);
                return;
            }
        }

        // Scroll to the message, if we toggled one message
        if (messageScroll.hasPromise()) {
            messageScroll.to(data);
            return;
        }

        return expendable;
    }

    /**
     * Find the position of the scrollable item
     * @return {Function} <index:Integer, max:Integer, type:String>
     */
    const getScrollToPosition = () => {
        const container = document.getElementById('pm_thread');
        const HEIGHT = 42;

        /**
         * Compute the size to remove or add for the scroll
         * @param  {Node} node Element
         * @param  {String} type Type of selection
         * @return {Number}
         */
        const getDelta = (node, type) => {
            if (type === 'UP') {

                // First element
                if (!node.previousElementSibling) {
                    return 0;
                }

                // If it's open add its size + the height of an item
                const isOpen = node.previousElementSibling.classList.contains('open');
                return isOpen ? node.previousElementSibling.offsetHeight + HEIGHT : HEIGHT;
            }

            // For the next one
            const isOpen = node.nextElementSibling && node.nextElementSibling.classList.contains('open');
            return isOpen ? node.nextElementSibling.offsetHeight + HEIGHT : HEIGHT;
        };

        return (index, max, type = 'UP') => {
            const $item = container.querySelector('.message.marked');
            if ($item) {

                const delta = getDelta($item, type);
                if (index === 0) {
                    return (container.scrollTop = 0);
                }

                if (type === 'UP') {
                    container.scrollTop -= delta;
                }

                if (type === 'DOWN') {
                    container.scrollTop = $item.offsetTop + delta - container.offsetHeight / 2;
                }
            }
        };
    };

    return {
        restrict: 'E',
        scope: {
            conversation: '='
        },
        templateUrl: 'templates/partials/conversation.tpl.html',
        link(scope) {
            let messagesCached = [];
            const unsubscribe = [];

            const scrollToPosition = getScrollToPosition();
            let unsubscribeActions = angular.noop;

            scope.mailbox = tools.currentMailbox();
            scope.labels = authentication.user.Labels;
            scope.currentState = $state.$current.name;
            scope.scrolled = false;
            scope.showTrashed = false;
            scope.showNonTrashed = false;
            $rootScope.numberElementSelected = 1;
            $rootScope.showWelcome = false;
            scope.inTrash = $state.includes('secured.trash.**');
            scope.inSpam = $state.includes('secured.spam.**');

            // Listeners
            unsubscribe.push($rootScope.$on('refreshConversation', (event, conversationIDs) => {
                if (conversationIDs.indexOf(scope.conversation.ID) > -1) {
                    scope.refreshConversation();
                }
            }));

            let expandableMessage;

            // We need to allow hotkeys for a message when you open the message
            unsubscribe.push($rootScope.$on('message.open', (event, { type, data }) => {
                if (type === 'toggle') {
                    unsubscribeActions();
                    unsubscribeActions = conversationListeners(data.message);

                    // Allow the user to scroll inside the conversation via the keyboard
                    hotkeys.unbind(['down', 'up']);
                    scope.markedMessage = undefined;
                }

                if (type === 'render') {
                    // Create a cache
                    expandableMessage = expandableMessage || getScrollableMessage(scope.messages);
                    return (expandableMessage = scrollToItem(expandableMessage, data));

                }
            }));

            scope.$on('$destroy', () => {
                unsubscribe.forEach((cb) => cb());
                unsubscribe.length = 0;
                unsubscribeActions();
                // Ensure only one event Listener
                hotkeys.unbind(['down', 'up']);
                hotkeys.bind(['down', 'up']);
                $rootScope.$emit('conversation.close', scope.conversation);
            });

            scope.$on('unmarkMessages', () => {
                scope.markedMessage = undefined;
                unsubscribeActions();
            });


            scope.$on('markPrevious', () => {
                unsubscribeActions();
                if (scope.markedMessage) {
                    const index = scope.messages.indexOf(scope.markedMessage);
                    if (index > 0) {
                        const pos = index - 1;
                        scope
                            .$applyAsync(() => {
                                scope.markedMessage = scope.messages[pos];
                                scrollToPosition(pos, scope.messages.length, 'UP');
                                unsubscribeActions = conversationListeners(scope.markedMessage);
                            });
                    }
                }
            });

            scope.$on('markNext', () => {
                unsubscribeActions();
                if (scope.markedMessage) {
                    const index = scope.messages.indexOf(scope.markedMessage);
                    if (index < (scope.messages.length - 1)) {
                        const pos = index + 1;
                        scope
                            .$applyAsync(() => {
                                scope.markedMessage = scope.messages[pos];
                                scrollToPosition(pos, scope.messages.length, 'DOWN');
                                unsubscribeActions = conversationListeners(scope.markedMessage);
                            });


                    }
                }
            });

            scope.$on('toggleStar', () => {
                scope.toggleStar();
            });

            // We don't need to check these events if we didn't choose to focus onto a specific message
            hotkeys.unbind(['down', 'up']);

            // Restore them to allow custom keyboard navigation
            scope.$on('left', () => hotkeys.bind(['down', 'up']));
            scope.$on('openMarked', () => {
                if (scope.markedMessage) {
                    if (scope.markedMessage.Type === CONSTANTS.DRAFT) {
                        return $rootScope.$emit('composer.load', scope.markedMessage);
                    }
                    $rootScope.$emit('message.open', {
                        type: 'toggle',
                        data: {
                            action: 'openMarked',
                            message: scope.markedMessage
                        }
                    });
                }

            });

            scope.$on('move', (event, mailbox) => {
                const ids = scope.markedMessage ? [scope.markedMessage.ID] : scope.messages.map(({ ID }) => ID);
                $rootScope.$emit('messageActions', { action: 'move', data: { ids, mailbox } });
            });

            scope.$on('right', () => {
                unsubscribeActions();
                !scope.markedMessage && scope
                    .$applyAsync(() => {
                        scope.markedMessage = _.last(scope.messages);
                        unsubscribeActions = conversationListeners(scope.markedMessage);
                        messageScroll.toID(scope.markedMessage.ID, scope.messages);

                        hotkeys.bind(['down', 'up']);
                    });
            });

            scope.$on('escape', () => {
                back();
            });

            /**
             * Back to the parent state
             */
            function back() {
                const name = $state.$current.name;
                const route = name.replace('.element', '');

                $state.go(route, { id: '' });
            }

            /**
             * Set a flag (expand) to the message to be expanded
             * @param {Array} messages
             * @return {Array} messages
             */
            function expandMessage(messages = []) {
                let thisOne;

                const filter = (cb) => _.chain(messages).filter(cb).last().value();

                switch (true) {
                    // If we open a conversation in the sent folder
                    case tools.typeView() === 'message':
                        thisOne = _.last(messages);
                        break;

                    case $stateParams.messageID:
                        thisOne = _.findWhere(messages, { ID: $stateParams.messageID });
                        break;

                    case $state.includes('secured.starred.**'):
                        // Select the last message starred
                        thisOne = filter(({ LabelIDs }) => LabelIDs.indexOf(CONSTANTS.MAILBOX_IDENTIFIERS.starred) !== -1);
                        break;

                    case $state.includes('secured.label.**'):
                        // Select the last message with this label
                        thisOne = filter(({ LabelIDs }) => LabelIDs.indexOf($stateParams.label) !== -1);
                        break;

                    case $state.includes('secured.drafts.**'):
                        thisOne = filter(({ Type }) => Type === CONSTANTS.DRAFT);
                        break;

                    default: {
                        const latest = filter(({ Type }) => Type !== CONSTANTS.DRAFT);

                        if (latest && latest.IsRead === 1) {
                            thisOne = latest;
                            break;
                        }

                        const withoutDraft = messages.filter(({ Type }) => Type !== CONSTANTS.DRAFT);

                        // Else we open the first message unread beginning to the end list
                        let loop = true;
                        let index = withoutDraft.length - 1;

                        while (loop === true && index > 0) {
                            index--;

                            if (withoutDraft[index].IsRead === 1) { // Is read
                                loop = false;
                                index++;
                            }
                        }

                        if (loop) { // No message read found
                            index = 0;
                        }

                        thisOne = withoutDraft[index];
                        break;
                    }
                }

                thisOne.openMe = true;

                return messages;
            }

            /**
             * Method call at the initialization of this directive
             */
            function initialization() {
                let messages = [];
                messagesCached = cache.queryMessagesCached($stateParams.id);
                scope.trashed = _.filter(messagesCached, (message) => { return _.contains(message.LabelIDs, CONSTANTS.MAILBOX_IDENTIFIERS.trash) === true; }).length > 0;
                scope.nonTrashed = _.filter(messagesCached, (message) => { return _.contains(message.LabelIDs, CONSTANTS.MAILBOX_IDENTIFIERS.trash) === false; }).length > 0;

                messages = $filter('filterMessages')(messagesCached, scope.showTrashed, scope.showNonTrashed);

                if (messages.length > 0) {

                    // Reset status
                    const list = _.map(cache.orderMessage(messages, false), (msg) => {
                        delete msg.expand;
                        delete msg.openMe;
                        return msg;
                    });

                    scope.messages = expandMessage(list);
                    unsubscribeActions = conversationListeners(_.last(scope.messages));

                    if (authentication.user.ViewLayout === CONSTANTS.ROW_MODE) {
                        scope.markedMessage = $rootScope.expandMessage;
                    }
                } else {
                    back();
                }
            }

            /**
             * Refresh the current conversation with the latest change reported by the event log manager
             */
            scope.refreshConversation = () => {

                const conversation = cache.getConversationCached($stateParams.id);
                const messages = cache.queryMessagesCached($stateParams.id);
                const loc = tools.currentLocation();

                messagesCached = messages;
                scope.trashed = messagesCached.some(({ LabelIDs = [] }) => _.contains(LabelIDs, CONSTANTS.MAILBOX_IDENTIFIERS.trash));
                scope.nonTrashed = messagesCached.some(({ LabelIDs = [] }) => !_.contains(LabelIDs, CONSTANTS.MAILBOX_IDENTIFIERS.trash));

                if (conversation) {
                    if (conversation.LabelIDs.indexOf(loc) !== -1 || $state.includes('secured.search.**')) {
                        _.extend(scope.conversation, conversation);
                    } else {
                        return back();
                    }
                } else {
                    return back();
                }

                if (Array.isArray(messages) && messages.length > 0) {
                    const toAdd = [];
                    const toRemove = [];
                    const list = cache
                        .orderMessage($filter('filterMessages')(messages, scope.showTrashed, scope.showNonTrashed), false);

                    for (let index = 0; index < list.length; index++) {
                        if (!scope.messages.some(({ ID }) => ID === list[index].ID)) {
                            toAdd.push({ index, message: list[index] });
                        }
                    }

                    for (let index = 0; index < toAdd.length; index++) {
                        const ref = toAdd[index];
                        // Insert new message at a specific index
                        scope.messages.splice(ref.index, 0, ref.message);
                    }

                    for (let index = 0; index < scope.messages.length; index++) {
                        if (!list.some(({ ID }) => ID === scope.messages[index].ID)) {
                            toRemove.push({ index });
                        }
                    }

                    for (let index = toRemove.length - 1; index >= 0; index--) {
                        // Remove message deleted
                        scope.messages.splice(toRemove[index].index, 1);
                    }
                } else {
                    back();
                }
            };

            scope.toggleOption = function (option) {
                scope[option] = !scope[option];
                scope.refreshConversation();
            };

            /**
             * @return {Boolean}
             */
            scope.showNotifier = function (folder) {
                const filtered = _.filter(messagesCached, (message) => { return _.contains(message.LabelIDs, CONSTANTS.MAILBOX_IDENTIFIERS[folder]); });

                return filtered.length < messagesCached.length && filtered.length > 0;
            };

            /**
             * Return messages data for dropdown labels
             */
            scope.getMessages = function () {
                return scope.messages;
            };

            /**
             * Mark current conversation as read
             * @param {Boolean} back
             */
            scope.read = function () {
                const ids = [scope.conversation.ID];

                actionConversation.readConversation(ids);
            };

            /**
             * Mark current conversation as unread
             */
            scope.unread = function () {
                const ids = [scope.conversation.ID];

                actionConversation.unreadConversation(ids);

                back();
            };

            /**
             * Delete current conversation
             */
            scope.delete = function () {
                const ids = [scope.conversation.ID];

                actionConversation.deleteConversation(ids);
            };

            /**
             * Move current conversation to a specific location
             */
            scope.move = function (mailbox) {
                const ids = [scope.conversation.ID];

                actionConversation.moveConversation(ids, mailbox);
            };

            /**
             * Apply labels for the current conversation
             * @return {Promise}
             */
            scope.saveLabels = function (labels, alsoArchive) {
                const ids = [scope.conversation.ID];

                actionConversation.labelConversation(ids, labels, alsoArchive);
            };

            /**
             * Toggle star status for current conversation
             */
            scope.toggleStar = function () {
                if (scope.starred() === true) {
                    scope.unstar();
                } else {
                    scope.star();
                }
            };

            /**
             * Star the current conversation
             */
            scope.star = function () {
                actionConversation.starConversation(scope.conversation.ID);
            };

            /**
             * Unstar the current conversation
             */
            scope.unstar = function () {
                actionConversation.unstarConversation(scope.conversation.ID);
            };

            /**
             * Return status of the star conversation
             * @return {Boolean}
             */
            scope.starred = function () {
                return scope.conversation.LabelIDs.indexOf(CONSTANTS.MAILBOX_IDENTIFIERS.starred) !== -1;
            };

            // Call initialization
            initialization();
        }
    };
});
