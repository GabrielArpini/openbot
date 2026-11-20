### Added

- Select an installed skill as an agent default or a chat mode on desktop, web and phone. Chats can inherit the default, select another skill or stay off. The full selected text is included at session start, resume and each normal message. Changes apply from the next turn; they do not guarantee model obedience.
- Include explicitly declared local skill dependencies with revision and content checks. Missing, disabled, changed or oversized content stops the turn until repaired or cleared. The complete instruction block must fit 32,000 characters; it is never shortened. Other skills remain available as usual. Joined servers must update to a version with `skill-modes-v1`.
