// Import the necessary discord.js classes
import 'dotenv/config.js';
import { Client, Events, GatewayIntentBits, VoiceState, VoiceChannel, ChannelType } from 'discord.js';
import {
    DiscordGatewayAdapterCreator,
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus
} from '@discordjs/voice';

// Grab Discord bot token and client ID
const token = process.env.DISCORD_BOT_TOKEN;
const clientID = process.env.DISCORD_CLIENT_ID;
const min_delay: number = parseInt(process.env.DISCORD_MIN_DELAY!);
const max_delay: number = parseInt(process.env.DISCORD_MAX_DELAY!);
let channelID_with_members: string | undefined = undefined;
let channelID_currently_in: string | undefined = undefined;
let timeout_handle: NodeJS.Timeout | undefined = undefined;

// Create audio player and define resource path
const player = createAudioPlayer();
const resource_path = 'song.mp3';
const player_active_guilds: string[] = [];

// Check if voice channel is empty
async function isChannelEmpty(channelID: string) {
    return await client.channels.fetch(channelID).then((channel) => {
        if (channel?.type === ChannelType.GuildVoice) {
            return channel.members.size === 0;
        }
    });
}

async function findNewChannel(guildID: string, adapter: DiscordGatewayAdapterCreator | undefined) {
    let found_new_channel = false;
    const guild = client.guilds.cache.get(guildID);
    const voiceChannels = guild?.channels.cache.filter((channel) => channel.type === ChannelType.GuildVoice);

    const promises: Promise<boolean | undefined>[] = [];

    // Check every available voice channel for members
    if (voiceChannels !== undefined) {
        for (const channel of voiceChannels?.values()) {
            const channelEmpty = await isChannelEmpty(channel.id);
            if (channelEmpty === false) {
                channelID_with_members = channel.id;
                found_new_channel = true;
                console.log(`${channelID_with_members} has targetable members.`);
                break;
            }
            promises.push(Promise.resolve(channelEmpty));
        }
    }

    await Promise.all(promises);

    // If a new channel with members is found,
    // target that channel.
    // Otherwise, give up
    if (found_new_channel === false) {
        console.log("Couldn't find anywhere else to go :<");
        clearTimeout(timeout_handle);
        timeout_handle = undefined;
        channelID_with_members = undefined;
    } else if (adapter !== undefined) {
        startJoinTimer(guildID, adapter);
    }
}

// Start timeout, join after random milliseconds delay between
// min_delay and max_delay
async function startJoinTimer(guildID: string, adapter: DiscordGatewayAdapterCreator) {
    const delay = Math.floor(Math.random() * (max_delay - min_delay) + min_delay);
    console.log(`Joining ${channelID_with_members} in ${delay} milliseconds.`);
    // channel_with_members is a global variable that can be
    // updated while the timer is running, in case all channels are vacated
    // or the orignal channel is vacated
    timeout_handle = setTimeout(() => {
        if (channelID_with_members !== undefined) {
            console.log('Joining the channel.');
            const connection = joinVoiceChannel({
                channelId: channelID_with_members,
                guildId: guildID,
                adapterCreator: adapter,
            });
            const resource = createAudioResource(resource_path);
            player.play(resource);
            connection.subscribe(player);
            player_active_guilds.push(guildID);
            channelID_currently_in = channelID_with_members;
            timeout_handle = undefined;
        }
    }, delay);
}

// Create a new client instance
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// When the client is ready, run this code (only once)
// We use 'c' for the event parameter to keep it separate from the already defined 'client'
client.once(Events.ClientReady, (c) => {
    console.log(`Ready! Logged in as ${c.user?.tag}`);
});

// Voice status updates are triggered by any member connecting, disconnecting, streaming,
// etc. to a voice channel
client.on('voiceStateUpdate', (oldVoiceState: VoiceState, newVoiceState: VoiceState) => {
    // If bot is disconnected, ensure audio player is stopped
    if (newVoiceState.member?.id === clientID && newVoiceState.channel?.id === undefined) {
        player.stop();
    }
    // If bot is the only member of the channel, disconnect it
    const connection = getVoiceConnection(newVoiceState.guild.id);
    if (connection !== undefined && channelID_currently_in !== undefined) {
        client.channels.fetch(channelID_currently_in).then((channel) => {
            if (channel?.type === ChannelType.GuildVoice) {
                if (channel.members.size === 1) {
                    connection.destroy();
                }
            }
        });
    }
    // Any voicestate change that does not involve the bot
    if (newVoiceState.member?.id !== clientID && connection === undefined) {
        if (channelID_with_members !== undefined) {
            // If channel_with_members is defined, that
            // means a countdown timer is already running
            isChannelEmpty(channelID_with_members).then((channelEmpty) => {
                // If the channel currently targeted is empty
                // due to a member disconnecting, attempt to target
                // the channel the user switched to.
                // If the user simply disconnected, check for
                // another populated channel.
                if (channelEmpty === true) {
                    console.log(`${channelID_with_members} now empty.`);
                    if (newVoiceState.channelId !== null) {
                        channelID_with_members = newVoiceState.channelId;
                        console.log(`Joining ${channelID_with_members} instead.`);
                    } else {
                        findNewChannel(newVoiceState.guild.id, undefined);
                    }
                }
            });
        }
        // Someone joins a channel (not the bot)
        if (newVoiceState.channelId !== null) {
            // Start a join timer if one was not already running
            // on the channel that member joined
            if (timeout_handle === undefined) {
                channelID_with_members = newVoiceState.channelId;
                const guildID = newVoiceState.guild.id;
                const adapter = newVoiceState.guild.voiceAdapterCreator;

                startJoinTimer(guildID, adapter);
            }
        }
    } else if (timeout_handle === undefined && newVoiceState.channel?.id === undefined) {
        // If anyone leaves a channel (including the bot, you cannot force her out), attempt
        // To find a channel with members and connect to it
        const guildID = oldVoiceState.guild.id;
        const adapter = oldVoiceState.guild.voiceAdapterCreator;
        findNewChannel(guildID, adapter);
    }
});

player.on(AudioPlayerStatus.Playing, () => {
    console.log('The audio player has started playing!');
});

player.on(AudioPlayerStatus.Idle, () => {
    if (player_active_guilds !== undefined) {
        const connection = getVoiceConnection(player_active_guilds.shift()!);
        connection?.destroy();
    }
});

// Log in to Discord with client's token
client.login(token);
