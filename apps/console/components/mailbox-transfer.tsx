/**
 * Where a mailbox's export and import will live on its page (U7 of the
 * mailboxes plan).
 *
 * ⚠ IT RENDERS NOTHING YET, ON PURPOSE. The routes exist (`GET` and `POST`
 * `/mailboxes/:address/export` and `/import`, apps/api/src/routes/mailbox-migration.ts)
 * and a deletion that chose "export first" already starts an export, but a
 * section that said "coming soon" would be a promise made to somebody who is
 * trying to move their mail. It is mounted in `MailboxDetail` between Storage and
 * the danger zone, which is where U7 fills it in: start an export, watch its
 * progress, download it, and upload an archive to import.
 *
 * ⚠ THE ROUTES ALLOW MORE THAN ADMINS: the mailbox's own owner may export and
 * import too. So the page passes `isAdmin` and nothing narrower, and U7 shows the
 * section to the owner as well; the API stays the check.
 */
export function MailboxTransfer(props: { address: string; isAdmin: boolean }) {
  void props
  return null
}
