export function maskPhone(phoneNumber: string): string {
  if (phoneNumber.length < 8) {
    return '***';
  }
  return `${phoneNumber.slice(0, 3)}****${phoneNumber.slice(-4)}`;
}
