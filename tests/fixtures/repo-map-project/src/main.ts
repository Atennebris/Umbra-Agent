import { AuthService } from './api/auth';

const auth = new AuthService();

export async function main() {
  const user = { id: '1', name: 'Test' };
  await auth.login(user);
}
