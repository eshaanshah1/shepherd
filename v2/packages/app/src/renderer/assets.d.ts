// Vite resolves a CSS side-effect import to an injected stylesheet; TypeScript
// wants to know that `'./styles.css'` is a thing that can be imported at all.
// Declared by hand rather than by pulling in `vite/client`, whose types also
// redeclare a pile of globals this package already gets from lib.DOM.
declare module '*.css' {
  const url: string;
  export default url;
}
