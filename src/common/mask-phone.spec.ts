import { maskPhone } from './mask-phone';

describe('maskPhone', () => {
  it('가운데 번호를 가린다', () => {
    expect(maskPhone('01012345678')).toBe('010****5678');
  });

  it('너무 짧으면 전부 가린다', () => {
    expect(maskPhone('0101')).toBe('***');
  });
});
