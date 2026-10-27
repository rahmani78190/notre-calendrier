/* Reçoit les rappels envoyés par Firebase et les affiche, même appli fermée. */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAcCRiahMYipVlgc39VxBimw35_e-041iA',
  authDomain: 'notre-calendrier-6e555.firebaseapp.com',
  projectId: 'notre-calendrier-6e555',
  storageBucket: 'notre-calendrier-6e555.firebasestorage.app',
  messagingSenderId: '976700266633',
  appId: '1:976700266633:web:bcc1f95f952f4fc7af0e58'
});
firebase.messaging();

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
