import { OrganizationMemberJoined } from "../src/templates/organization-member-joined"

export default function Preview() {
  return (
    <OrganizationMemberJoined
      url="https://dash.i10.tech"
      organizationName="Acme"
      emailAddress="new@acme.com"
    />
  )
}
