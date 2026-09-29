import { Body, Button, Container, Heading, Html, Text } from "@react-email/components"

interface Props {
  name: string
  url: string
  team: { name: string }
}

export default function Welcome({ name, url, team }: Props) {
  return (
    <Html>
      <Body>
        <Container>
          <Heading>Welcome to {team.name}</Heading>
          <Text>Hi {name}, you were invited to join.</Text>
          <Button href={url}>Join {team.name}</Button>
        </Container>
      </Body>
    </Html>
  )
}

Welcome.PreviewProps = {
  name: "Ada",
  url: "https://example.com/join",
  team: { name: "Acme" },
} satisfies Props
