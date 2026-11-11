/*
 * ===================== SITE CONFIGURATION =====================
 * This is the only file you need to edit by hand (once, during setup).
 * Everything else — text, photos, team, races, cards — is managed
 * from the admin console at  /admin.html
 */
window.SITE_CONFIG = {

  // GitHub repository that hosts this site. Leave blank to auto-detect
  // when the site is served from  <owner>.github.io/<repo>/
  // Fill these in if you use a custom domain.
  github: {
    owner: '',   // e.g. 'your-github-username'
    repo: '',    // e.g. 'apx-gp-site'
    branch: '',  // blank = the repository's default branch
  },

  // Firebase — powers fan accounts, coins and card packs.
  // Paste the config object from Firebase Console → Project settings → Your apps → Web app.
  // Leave as null to hide packs until you're ready (the rest of the site works without it).
  firebase: null,
  // firebase: {
  //   apiKey: '...',
  //   authDomain: 'your-project.firebaseapp.com',
  //   projectId: 'your-project',
  //   storageBucket: 'your-project.appspot.com',
  //   messagingSenderId: '...',
  //   appId: '...',
  // },

  // Allow "Continue with Google" sign-in for fans (enable Google in Firebase Authentication first).
  googleSignIn: false,

  firebaseVersion: '12.15.0',
};
