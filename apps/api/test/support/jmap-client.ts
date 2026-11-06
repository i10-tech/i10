import type { JmapAsClient } from "../../src/mail/jmap-as.js"

/**
 * A `JmapAsClient` for tests: the methods a test supplies, and for the rest a
 * method that throws when called.
 *
 * ⚠ THE CLIENT GROWS (groups, blobs, whatever is next), and a test double typed
 * as the whole interface stops compiling each time. Naming only what a test uses
 * keeps the others from breaking, and a call to one it did not name fails loudly
 * instead of returning `undefined`.
 */
export function fakeJmapClient(methods: Partial<JmapAsClient>): JmapAsClient {
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`the test's fake JMAP client has no ${name}`)
  }
  return {
    call: unused("call"),
    callAsGroup: unused("callAsGroup"),
    destroyGroup: unused("destroyGroup"),
    revokeGroup: unused("revokeGroup"),
    downloadBlob: unused("downloadBlob"),
    uploadBlob: unused("uploadBlob"),
    ...methods,
  }
}
