import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * An admin accepted somebody's request to join (#327). "Accept and notify" is
 * the one flow: everybody accepted hears they are in, and somebody who waited
 * because the workspace was full hears that a spot opened up.
 */
export const joinAcceptedSubject = (workspace: string, waited: boolean) =>
  waited ? `A spot opened up in ${workspace}` : `You're in ${workspace}`

export default function JoinAccepted({
  workspace,
  waited,
  url,
}: {
  workspace: string
  waited: boolean
  url: string
}) {
  return (
    <Layout preview={joinAcceptedSubject(workspace, waited)}>
      <Text style={styles.heading}>
        {waited ? "A spot opened up, you're in" : "You're in"}
      </Text>
      <Text style={styles.text}>
        {waited
          ? `${workspace} was full when you tried to join. An admin made room and added you.`
          : `An admin accepted your request to join ${workspace}.`}
      </Text>
      <ActionButton href={url}>{`Open ${workspace}`}</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

JoinAccepted.PreviewProps = {
  workspace: "Acme",
  waited: true,
  url: "https://console.i10.tech",
} satisfies React.ComponentProps<typeof JoinAccepted>
