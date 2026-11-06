# Security Specification (`security_spec.md`)

## 1. Data Invariants
1. **Strict Device & User Isolation**: A `/deviceUnlocks/{unlockId}` document can only be created, read, or updated by the verified authenticated owner (`request.auth.uid == resource.data.ownerId` and `request.auth.token.email_verified == true`). One user/device can NEVER read or unlock another device's record.
2. **Schema & Volumetric Boundaries**: Every string field (`ownerId`, `deviceId`, `orderId`, `unlockKey`) enforces strict character length limits and regex validation matching `firebase-blueprint.json`.
3. **Immutable Ownership & Creation Metadata**: `ownerId`, `deviceId`, `orderId`, `amount`, and `createdAt` cannot be modified after creation.
4. **Terminal State Locking**: Once `status` reaches `'PAID'`, no further updates are permitted (`existing().status != 'PAID'`).
5. **Temporal Integrity**: `createdAt` on create and `updatedAt` on update must strictly equal `request.time`.

## 2. The "Dirty Dozen" Payloads
1. **Unauthenticated Write**: `auth = null`, creating `/deviceUnlocks/doc1` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: `auth = { uid: 'u1', token: { email_verified: false } }`, creating `/deviceUnlocks/doc1` -> `PERMISSION_DENIED`.
3. **Identity Spoofing on Create**: `auth.uid = 'u1'`, payload `ownerId: 'u2'` -> `PERMISSION_DENIED`.
4. **Cross-Device Read Leak**: `auth.uid = 'u2'`, reading `/deviceUnlocks/doc_owned_by_u1` -> `PERMISSION_DENIED`.
5. **Unfiltered List Scraping**: `auth.uid = 'u1'`, listing `/deviceUnlocks` without `where('ownerId', '==', 'u1')` -> `PERMISSION_DENIED`.
6. **Shadow / Ghost Field Injection**: Adding `isAdmin: true` to `/deviceUnlocks/doc1` -> `PERMISSION_DENIED`.
7. **ID Poisoning Attack**: Document ID `unlockId` > 128 chars or containing special chars -> `PERMISSION_DENIED`.
8. **Value Poisoning on Update**: Updating `status` to `'HACKED'` (outside enum `['PENDING', 'PAID']`) -> `PERMISSION_DENIED`.
9. **Owner Transfer Attack**: Updating `ownerId` or `deviceId` during update -> `PERMISSION_DENIED`.
10. **Terminal State Re-Mutation**: Updating a document whose `existing().status == 'PAID'` -> `PERMISSION_DENIED`.
11. **Forged Client Timestamp**: Setting `createdAt` to a past/future timestamp instead of `request.time` -> `PERMISSION_DENIED`.
12. **Unauthorized Delete**: Deleting `/deviceUnlocks/doc1` -> `PERMISSION_DENIED`.
