import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  import.meta.dirname,
  ['lib/types/index.js'],
  {
    lib: {
      copy: [{
        from: 'src/styles/{design-platform.css,gradient-shadow-text.css,brand-font.css,montserrat-*.woff2,Montserrat-OFL.txt}',
        to: 'lib/styles',
      }],
    },
  },
)
