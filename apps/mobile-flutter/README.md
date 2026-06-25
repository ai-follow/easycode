# EasyCode Mobile Flutter

This folder contains the native mobile client source skeleton. Flutter is not
installed on this machine, so the generated Android/iOS platform folders are
not checked in yet.

After installing Flutter:

```bash
cd apps/mobile-flutter
flutter create --platforms android,ios .
flutter pub get
flutter run
```

The app mirrors the same relay protocol used by `apps/mobile-web`: claim a
pairing code, connect to `/v1/ws`, render `session_snapshot` and `client_event`
payloads, and send `user_input` payloads back to the desktop agent.
