type Query = Record<string, string | number | undefined | null> | undefined
type Route = [
  RegExp,
  (match: RegExpMatchArray, query: Query, method: string, body?: unknown) => unknown,
]

export function mailboxRoutes(_notFound: unknown): Route[] {
  void _notFound
  const data = [
    {
      address: "alice@acme.dev",
      displayName: "Alice Admin",
      owner: {
        userId: "user_alice",
        clerkUserId: "user_alice",
        name: "Alice Admin",
        email: "alice@acme.dev",
      },
      domain: "acme.dev",
      status: "active",
      signIn: "password",
      aliases: [],
      storage: {
        allocatedBytes: 5368709120,
        usedBytes: 1234567890,
        usedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      address: "bob@acme.dev",
      displayName: "Bob Builder",
      owner: {
        userId: "user_bob",
        clerkUserId: "user_bob",
        name: "Bob Builder",
        email: "bob@acme.dev",
      },
      domain: "acme.dev",
      status: "payment_hold",
      signIn: "oidc",
      aliases: [],
      storage: {
        allocatedBytes: 2147483648,
        usedBytes: 2000000000,
        usedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      address: "carol@acme.dev",
      displayName: "Carol Chen",
      owner: {
        userId: "user_carol",
        clerkUserId: "user_carol",
        name: "Carol Chen",
        email: "carol@acme.dev",
      },
      domain: "acme.dev",
      status: "sso_required",
      signIn: "off",
      aliases: [],
      storage: { allocatedBytes: null, usedBytes: 0, usedAt: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      address: "dan@acme.dev",
      displayName: null,
      owner: {
        userId: "user_dan",
        clerkUserId: "user_dan",
        name: null,
        email: "dan@acme.dev",
      },
      domain: "acme.dev",
      status: "inactive",
      signIn: "off",
      aliases: [],
      storage: { allocatedBytes: 1073741824, usedBytes: null, usedAt: null },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]

  return [
    [
      /^\/console\/mailboxes$/,
      (_m, query) => {
        const empty = query?.empty === "1" || query?.empty === 1
        return {
          data: empty ? [] : data,
          pool: {
            kind: "pool",
            total: 10737418240,
            allocated: data.reduce((s, m) => s + (m.storage.allocatedBytes ?? 0), 0),
            used: 3234567890,
            remaining: 5368709120,
            unallocated: 1,
          },
          nextCursor: null,
        }
      },
    ],
  ]
}
