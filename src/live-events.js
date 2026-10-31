import { createChatFilter } from './filters.js';

function welcome(names) {
  return `Welcome ${names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}`;
}

export function createLiveEvents(queue) {
  const acceptUser = createChatFilter();
  let followers = [];
  let timer;
  let stopped = false;

  function flush() {
    timer = undefined;
    let batch = [];
    for (const name of followers) {
      if ([...welcome([...batch, name])].length > 150) {
        queue.enqueue({ type: 'follow', name: 'New followers', text: welcome(batch) });
        batch = [];
      }
      batch.push(name);
    }
    followers = [];
    if (batch.length) queue.enqueue({ type: 'follow', name: 'New followers', text: welcome(batch) });
  }

  return {
    handle(type, event) {
      if (stopped || !event || !['channel.follow', 'channel.subscribe',
        'channel.subscription.message', 'channel.raid'].includes(type)) return;
      const raid = type === 'channel.raid';
      const name = raid ? event.from_broadcaster_user_name : event.user_name;
      const userId = raid ? event.from_broadcaster_user_id : event.user_id;
      if (typeof name !== 'string' || !/^[\p{L}\p{N}_]{1,25}$/u.test(name) || !acceptUser(userId, name)) return;
      if (type === 'channel.follow') {
        followers.push(name);
        if (!timer) timer = setTimeout(flush, 5000);
      } else {
        let text;
        if (raid) text = `Welcome ${name} and your community, thanks for the raid!`;
        else if (type === 'channel.subscription.message') text = `Welcome back ${name}, thanks for resubscribing!`;
        else text = event.is_gift === true ? `${name}, enjoy your gifted subscription!` : `${name}, thanks for subscribing!`;
        queue.enqueue({ type: raid ? 'raid' : 'sub', name, text });
      }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      followers = [];
    },
  };
}
