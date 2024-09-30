export interface Users {
    [name: string]: {
        number: string,
        token: string | null,
        old_token: string | null,
    }
}
export interface User {
    name: string;
    number: string;
    auth: string | null;
}

export const getNumberByName = (name: string, users: Record<string, { number: string; token: string | null; old_token: string | null }>): string | undefined => {
    const user = users[name.toLowerCase()];
    return user ? user.number : undefined;
};
// A function to extract name and number from the user input
export const extractNameAndNumber = (input: string): [string | null, string | null] => {
    const parts = input.split(' ');
    if (parts.length === 2) {
        const name = parts[0];
        let number = parts[1];

        // Remove all non-digit characters except for +
        number = number.replace(/[^\d+]/g, '');

        // If the number starts with 8, replace it with +7
        if (number.startsWith('8')) {
            number = '+7' + number.slice(1);
        } else if (!number.startsWith('+7')) {
            number = '+7' + number.slice(-10); // Handles numbers missing +7 or starting from 7
        }

        return [name, number];
    }
    return [null, null];
};
