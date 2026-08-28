/** Analyzer-only public surface for npm-installed Typert protocol metadata. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface TypertRemoteMap {}
  export interface TypertRemoteScopeMap {}
  export interface TypertContextMap {}

  export interface RemoteFailure {
    readonly code: string
    readonly message: string
    readonly details: object
  }

  export type RemoteResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: RemoteFailure }

  export abstract class TypertRemoteService {
    protected constructor(ctx: unknown, serviceKey: string, options?: { readonly namespace?: string })
  }

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void

  export function Remote(exportName: string): <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
}
