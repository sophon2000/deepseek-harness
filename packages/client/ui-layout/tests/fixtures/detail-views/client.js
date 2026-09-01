// Authored test artifact in the public client-factory format. Only React is a
// platform external; navigation and registration use Cordis/Slot public faces.
window.__ModuleLoader__.load({
  id: '@dsh-test/detail-views',
  factory: (require) => {
    const { createElement: h } = require('react')
    function View({ sessionId, label }) {
      return h('section', { 'data-fixture-view': label },
        h('h2', null, label), h('p', null, `Session ${sessionId}`),
        h('button', null, 'Object action'))
    }
    function Controls({ sessionId, open, removeA, restoreA }) {
      return h('span', null,
        h('button', { onClick: () => open(sessionId, 'fixture-a') }, 'Open workspace A'),
        h('button', { onClick: () => open(sessionId, 'fixture-b') }, 'Open workspace B'),
        h('button', { onClick: removeA }, 'Remove workspace A'),
        h('button', { onClick: restoreA }, 'Restore workspace A'))
    }
    return {
      inject: ['slots', 'detailViews'],
      apply(ctx) {
        const createView = (id, label) => ctx.plugin({
          inject: ['slots'],
          apply(child) {
            child.slots.inject('shell.details.view', () => child.slots.register({
              name: 'shell.details.view', id, label,
              inject: () => ({ label }),
            }, View))
          },
        })
        let a = createView('fixture-a', 'Workspace A')
        createView('fixture-b', 'Workspace B')
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions', id: 'detail-fixture-controls',
          inject: () => ({
            open: (sessionId, viewId) => ctx.detailViews.open(sessionId, viewId),
            removeA: async () => { await a?.dispose(); a = undefined },
            restoreA: () => { a ??= createView('fixture-a', 'Workspace A') },
          }),
        }, Controls))
      },
    }
  },
})
