import { OrganizationInvitation } from "../src/templates/organization-invitation"

export default function Preview() {
  return (
    <OrganizationInvitation
      url="https://auth.i10.tech/accept?ticket=sample"
      organizationName="Acme"
      inviterName="Mohamed"
    />
  )
}
