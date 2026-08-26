# Markdown editing dogfood

Use a fresh version per case. Save must change only the selected prose; a refused unsafe edit must
leave the source untouched.

## A · Repeated accented text

Matched résumé matters.

### Apply

Send a **résumé** or LinkedIn profile.

_Gesture:_ change the accented noun in the Apply section to its unaccented spelling.  
_Expect:_ only the bold occurrence changes.

## B · Adjacent formatted lines

**San Francisco · Full-time · In person**  
**$150,000–$180,000 base + discretionary bonus + carry eligibility**

_Gesture:_ select from the final working-mode word through the compensation line and replace the
selection with only that final word.  
_Expect:_ the first bold line remains valid and the second disappears completely.

## C · Fence metadata versus body

```value
value
```

_Gesture:_ change the rendered code-body word.  
_Expect:_ the fence info string remains byte-identical.

## D · Deep container prefixes

> - outer
>   > quoted **value**

_Gesture:_ change the bold word in the nested quote.  
_Expect:_ every `>` and list prefix remains untouched.

## E · Significant inline-code whitespace

The payload is ``  a  `` and its padding matters.

_Gesture:_ select the full rendered code payload, including its significant edge spaces, and type
`X`.  
_Expect:_ the result remains a fenced inline code span containing `X`.

## F · Structural refusal

before ![critical diagram](critical.png) after

_Gesture:_ try to replace a selection spanning the words on both sides of the image.  
_Expect:_ the edit is refused and the image source remains present.

## G · Later prefixed fence sibling

> ```ts
> firstBody
> ```
>
> ```ts
> secondBody
> ```

_Gesture:_ edit only the code word in the second quoted fence.  
_Expect:_ both fence shells and the first body remain byte-identical.

## H · Multiline list continuation

> - container
>   firstLine
>   secondLine

_Gesture:_ select the two continuation lines as one rendered span and replace them with one word.  
_Expect:_ every quote/list prefix survives and the second authored line disappears cleanly.

## I · Later list-item siblings

- parent
  first paragraph

  laterParagraph

  ```ts
  laterCode
  ```

_Gesture:_ edit the later paragraph and the code body in separate fresh versions.  
_Expect:_ each later child is addressable without changing the first paragraph, indentation, or fence.
