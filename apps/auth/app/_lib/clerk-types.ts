import type { useSignIn, useSignUp } from "@clerk/nextjs"

/**
 * The flow types, derived from the hooks rather than imported.
 *
 * ⚠ `@clerk/types` IS NOT A RESOLVABLE PACKAGE HERE, and importing from it
 * compiles against nothing. In this version the type definitions live inside
 * `@clerk/shared`, which is a transitive dependency we do not declare and have
 * no business reaching into — a package that moves its internals in a patch
 * release would break us for having read them.
 *
 * Deriving from `useSignIn` and `useSignUp` binds these to the only surface
 * Clerk actually promises us: the hooks we call. If a signature changes, this
 * file changes with it and every call site fails to compile — which is the
 * outcome we want from a version bump.
 */

export type SignInFlow = NonNullable<ReturnType<typeof useSignIn>["signIn"]>
export type SignUpFlow = NonNullable<ReturnType<typeof useSignUp>["signUp"]>

/** What every flow method returns in its `error` field. */
export type FlowError = Awaited<ReturnType<SignInFlow["password"]>>["error"]

/** `oauth_google` and friends, exactly as Clerk enumerates them. */
export type SsoStrategy = Parameters<SignInFlow["sso"]>[0]["strategy"]
