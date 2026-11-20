const PropTypes = require('prop-types');
const React = require('react');
const {useState, useCallback} = React;
<<<<<<< HEAD
=======
const Modal = require('../base/modal.jsx');
>>>>>>> 0c341c888eafddd30bd8e462800c2f0069484693
const TosFlow = require('../../tos-flow/tos-flow.jsx');

require('./modal.scss');

const TosModal = ({user}) => {
    const [isOpen, setIsOpen] = useState(true);

    const handleClose = useCallback(() => setIsOpen(false), [setIsOpen]);

<<<<<<< HEAD
    // Keep the consent/profile steps, but render them as a normal page instead
    // of blocking the ScratchWWW interface with the legacy overlay modal.
    if (!isOpen) return null;
    return (
        <main className="tos-flow-page">
=======
    return (
        <Modal
            isOpen={isOpen}
            showCloseButton={false}
            useStandardSizes
            className="tos-modal"
            shouldCloseOnOverlayClick={false}
        >
>>>>>>> 0c341c888eafddd30bd8e462800c2f0069484693
            <TosFlow
                user={user}
                onComplete={handleClose}
            />
<<<<<<< HEAD
        </main>
=======
        </Modal>
>>>>>>> 0c341c888eafddd30bd8e462800c2f0069484693
    );
};

TosModal.propTypes = {
    user: PropTypes.shape({
        id: PropTypes.number.isRequired,
        token: PropTypes.string.isRequired,
        country: PropTypes.string,
        state: PropTypes.string,
        birthYear: PropTypes.number,
        birthMonth: PropTypes.number,
        email: PropTypes.string,
        underConsentAge: PropTypes.bool,
        parentalConsentRequired: PropTypes.bool,
        withParentEmail: PropTypes.bool,
        isEducator: PropTypes.bool
    })
};

module.exports = TosModal;
