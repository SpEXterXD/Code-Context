/** User domain model and record shape. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface UserRecord extends User {
  passwordHash: string;
}

export function toPublicUser(record: UserRecord): User {
  const { passwordHash, ...rest } = record;
  void passwordHash;
  return { ...rest };
}
