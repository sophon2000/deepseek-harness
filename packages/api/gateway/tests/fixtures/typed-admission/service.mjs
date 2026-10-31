import { Service } from '@deepseek-ai/cordis'
import { Remote, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'

const initializers = []
export default class AdmissionFixture extends Service {
  constructor(ctx) {
    super(ctx, 'admissionFixture')
    this.typertRemote = bindTypertRemote(this, 'admissionFixture')
    this.calls = 0
    this.lookups = 0
    this.resolveTarget = id => ({ id })
    ctx.typert.lookups.register('admissionTarget', {
      parameter: 'target', wire: 'targetId', hostTypeSymbol: '@fixture/admission#Target', wireTypeSymbol: 'string',
      resolve: id => { this.lookups++; return this.resolveTarget(id) },
    })
    for (const initialize of initializers) initialize.call(this)
  }
  read(target, request) { this.calls++; return `${target.id}:${request.title}` }
  follow(target, request) { this.calls++; return [`${target.id}:${request.title}`] }
}
AdmissionFixture.inject = ['typert']
for (const method of ['read', 'follow']) {
  const decorator = method === 'read' ? Remote : Remote({ mode: 'stream' })
  decorator(AdmissionFixture.prototype[method], {
    kind: 'method', name: method, static: false, private: false,
    addInitializer(fn) { initializers.push(fn) },
  })
}
