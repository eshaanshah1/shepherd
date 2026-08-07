// Small shared mechanics. Anything here is used by at least two subsystems and
// takes its time from the injected `Clock`, never from `setTimeout`.
export { debounce, type Debounced } from './debounce.ts';
