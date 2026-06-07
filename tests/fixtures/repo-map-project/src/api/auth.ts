export interface User {
  id: string;
  name: string;
}

export function getUser(id: string): User {
  return { id, name: 'Umbra' };
}

export class AuthService {
  async login(user: User): Promise<boolean> {
    return !!user.id;
  }
}
