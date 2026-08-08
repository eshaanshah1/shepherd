// A CSS side-effect import is a thing TypeScript has to be told exists.
//
// The renderer declares the identical shape (`app/src/renderer/assets.d.ts`) and
// this is a deliberate copy rather than a shared file: a package that exists so
// extensions can import it must not need the app to typecheck, which is the same
// argument `test-dom.ts` is copied for.
//
// Only the TESTS import CSS here — the barrel does not, because a stylesheet
// that mounts itself is a stylesheet whose cascade order nobody controls. The
// tests need it because two of this package's invariants (Row's height, the
// Composer's role re-declaration) live in the CSS rather than in the markup.
declare module '*.css' {
  const url: string;
  export default url;
}
