import type { BlobByteRange } from "@derive/core"

export const assertBlobByteRange = ({ offset, length }: BlobByteRange): void => {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0)
    throw new RangeError("blob range needs non-negative safe-integer offset and length")
}
