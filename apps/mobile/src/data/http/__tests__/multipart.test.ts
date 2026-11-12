import { decodeBase64, encodeMultipart } from '../multipart';

const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);

describe('multipart upload encoding', () => {
  it('decodes standard base64, with or without padding', () => {
    expect([...decodeBase64('/9j/')]).toEqual([0xff, 0xd8, 0xff]);
    expect([...decodeBase64('aGk=')]).toEqual([104, 105]);
    expect([...decodeBase64('aGk')]).toEqual([104, 105]);
  });

  it('rejects text that is not base64', () => {
    expect(() => decodeBase64('not base64!')).toThrow(TypeError);
  });

  it('sends the data URI as a file part of raw bytes and other fields as text', () => {
    const { bytes, contentType } = encodeMultipart(
      { kind: 'selfie', caption: undefined, file: 'data:image/jpeg;base64,/9j/' },
      'XYZ',
    );
    expect(contentType).toBe('multipart/form-data; boundary=XYZ');
    const body = text(bytes);
    expect(body).toContain(
      '--XYZ\r\nContent-Disposition: form-data; name="kind"\r\n\r\nselfie\r\n',
    );
    expect(body).toContain('name="file"; filename="upload"\r\nContent-Type: image/jpeg\r\n\r\n');
    expect(body).toContain('\xff\xd8\xff\r\n--XYZ--\r\n');
    expect(body).not.toContain('caption');
  });

  it('refuses a file that is not a base64 data URI', () => {
    expect(() => encodeMultipart({ file: 'file:///photo.jpg' })).toThrow(TypeError);
    expect(() => encodeMultipart({ file: 'data:image/png,abc' })).toThrow(TypeError);
  });
});
