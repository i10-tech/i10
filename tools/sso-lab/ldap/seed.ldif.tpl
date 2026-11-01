# Seed directory for the i10 SSO lab. @BASE_DN@, @LAB_DOMAIN@ and
# @USER_PASSWORD@ / @SERVICE_PASSWORD@ are filled in by the compose entrypoint.
# Throwaway people, throwaway passwords. Stored in clear so every IdP can bind.

dn: ou=people,@BASE_DN@
objectClass: organizationalUnit
ou: people

dn: ou=groups,@BASE_DN@
objectClass: organizationalUnit
ou: groups

dn: ou=service,@BASE_DN@
objectClass: organizationalUnit
ou: service

# The account i10's LDAP pass-through searches with (read-only by ACL).
dn: cn=svc-i10,ou=service,@BASE_DN@
objectClass: organizationalRole
objectClass: simpleSecurityObject
cn: svc-i10
userPassword: @SERVICE_PASSWORD@

dn: uid=alice,ou=people,@BASE_DN@
objectClass: inetOrgPerson
uid: alice
cn: Alice Admin
givenName: Alice
sn: Admin
mail: alice@@LAB_DOMAIN@
title: Engineering lead
userPassword: @USER_PASSWORD@

dn: uid=bob,ou=people,@BASE_DN@
objectClass: inetOrgPerson
uid: bob
cn: Bob Builder
givenName: Bob
sn: Builder
mail: bob@@LAB_DOMAIN@
title: Engineer
manager: uid=alice,ou=people,@BASE_DN@
userPassword: @USER_PASSWORD@

dn: uid=carol,ou=people,@BASE_DN@
objectClass: inetOrgPerson
uid: carol
cn: Carol Coder
givenName: Carol
sn: Coder
mail: carol@@LAB_DOMAIN@
title: Engineer
userPassword: @USER_PASSWORD@

dn: uid=dave,ou=people,@BASE_DN@
objectClass: inetOrgPerson
uid: dave
cn: Dave Deals
givenName: Dave
sn: Deals
mail: dave@@LAB_DOMAIN@
title: Head of sales
userPassword: @USER_PASSWORD@

dn: uid=erin,ou=people,@BASE_DN@
objectClass: inetOrgPerson
uid: erin
cn: Erin Closer
givenName: Erin
sn: Closer
mail: erin@@LAB_DOMAIN@
title: Account executive
manager: uid=dave,ou=people,@BASE_DN@
userPassword: @USER_PASSWORD@

dn: uid=frank,ou=people,@BASE_DN@
objectClass: inetOrgPerson
uid: frank
cn: Frank Root
givenName: Frank
sn: Root
mail: frank@@LAB_DOMAIN@
title: IT administrator
userPassword: @USER_PASSWORD@

dn: cn=engineering,ou=groups,@BASE_DN@
objectClass: groupOfNames
cn: engineering
member: uid=alice,ou=people,@BASE_DN@
member: uid=bob,ou=people,@BASE_DN@
member: uid=carol,ou=people,@BASE_DN@

dn: cn=sales,ou=groups,@BASE_DN@
objectClass: groupOfNames
cn: sales
member: uid=dave,ou=people,@BASE_DN@
member: uid=erin,ou=people,@BASE_DN@

dn: cn=admins,ou=groups,@BASE_DN@
objectClass: groupOfNames
cn: admins
member: uid=alice,ou=people,@BASE_DN@
member: uid=frank,ou=people,@BASE_DN@
