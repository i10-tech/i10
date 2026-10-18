import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * A workspace's members reached 80% or 100% of its plan's member limit
 * (#327). To its admins only, once per crossing.
 *
 * ⚠ MEMBERS ONLY. Pending invitations do not raise this; they are counted
 * on the Team page, where an admin can see which ones would take the rest.
 */
export const memberCapacitySubject = (level: 80 | 100, workspace: string) =>
  level === 100
    ? `${workspace} has reached its member limit`
    : `${workspace} is close to its member limit`

export default function MemberCapacity({
  workspace,
  level,
  members,
  limit,
  url,
}: {
  workspace: string
  level: 80 | 100
  members: number
  limit: number
  url: string
}) {
  const title = memberCapacitySubject(level, workspace)
  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      <Text style={styles.text}>
        {workspace} has {members} of {limit} members.{" "}
        {level === 100
          ? "Nobody new can join until a spot frees up - invitations, requests and automatic joins all wait."
          : `${limit - members === 1 ? "One spot is" : `${limit - members} spots are`} left, and pending invitations take spots too.`}
      </Text>
      <Text style={styles.text}>
        To make room, remove a member or withdraw an invitation on the Team page, or
        move to a plan with more members.
      </Text>
      <ActionButton href={url}>Open team</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

MemberCapacity.PreviewProps = {
  workspace: "Acme",
  level: 80,
  members: 16,
  limit: 20,
  url: "https://console.i10.tech/settings/team",
} satisfies React.ComponentProps<typeof MemberCapacity>
